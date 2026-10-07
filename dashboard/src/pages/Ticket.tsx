/**
 * One ticket: what the tester said and saw, where it came from, what happened
 * to it since, and where to send it next.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  TICKET_STATUSES,
  type AttachmentView,
  type IntegrationView,
  type TicketDetail,
  type TicketEventView,
  type TicketPatch,
  type TicketStatus,
} from '@snitch/contract';
import { del, errorText, get, patch, post } from '../lib/api';
import { RELEASE_LABEL, STATUS_LABEL, bytes, dateTime, osName, relativeTime } from '../lib/format';
import { qk, useIntegrations, useUsers } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { ArrowLeft, External, Link as LinkIcon, Send } from '../components/icons';
import { Avatar, Dialog, EscalationPill, IntegrationIcon, useToast } from '../components/ui';

export function Ticket({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const ticket = useQuery({
    queryKey: qk.ticket(id),
    queryFn: () => get<TicketDetail>(`/tickets/${id}`),
    refetchInterval: (q) => (q.state.data?.escalations.some((e) => e.state === 'queued') || q.state.data?.ticket.uploadState === 'pending' ? 3000 : 30_000),
  });
  const users = useUsers();
  const integrations = useIntegrations(ticket.data?.project.id);

  const update = (data: TicketDetail) => {
    qc.setQueryData(qk.ticket(id), data);
    void qc.invalidateQueries({ queryKey: ['tickets'] });
    void qc.invalidateQueries({ queryKey: qk.projects });
  };
  const patchTicket = useMutation({
    mutationFn: (body: TicketPatch) => patch<TicketDetail>(`/tickets/${id}`, body),
    onSuccess: update,
    onError: (e) => toast(errorText(e)),
  });
  const escalate = useMutation({
    mutationFn: (integrationId: string) => post<TicketDetail>(`/tickets/${id}/escalations`, { integrationId }),
    onSuccess: (d) => (update(d), toast('Escalation queued')),
    onError: (e) => toast(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => del(`/tickets/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: qk.projects });
      toast('Ticket deleted');
      navigate('/');
    },
    onError: (e) => toast(errorText(e)),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (ticket.isLoading) return <div className="page empty">Loading…</div>;
  if (ticket.isError || !ticket.data) return <div className="page empty error-text">{ticket.error ? errorText(ticket.error) : 'Not found'}</div>;
  const d = ticket.data;
  const t = d.ticket;
  const typeLabel = (tid: string) => d.project.reportTypes.find((r) => r.id === tid)?.label ?? tid;
  const screenshot = d.attachments.find((a) => a.stored && a.contentType.startsWith('image/'));
  const video = d.attachments.find((a) => a.stored && a.contentType === 'video/mp4');
  const logs = d.attachments.find((a) => a.stored && (a.contentType === 'text/plain' || a.contentType === 'application/x-ndjson'));

  return (
    <div className="page">
      <div className="row small" style={{ marginBottom: 12 }}>
        <Link href="/" className="row muted">
          <ArrowLeft className="icon-inline" /> Inbox
        </Link>
        <span className="muted">/</span>
        <span className="mono muted">{t.key}</span>
        <span className="muted">· {d.project.name}</span>
      </div>

      <div className="stack" style={{ marginBottom: 16 }}>
        <TitleEditor key={t.title} value={t.title} onSave={(title) => patchTicket.mutate({ title })} />
        <div className="row wrap">
          <select aria-label="Status" value={t.status} onChange={(e) => patchTicket.mutate({ status: e.target.value as TicketStatus })}>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select aria-label="Type" value={t.type} onChange={(e) => patchTicket.mutate({ type: e.target.value })}>
            {!d.project.reportTypes.some((r) => r.id === t.type) && <option value={t.type}>{t.type}</option>}
            {d.project.reportTypes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <select aria-label="Assignee" value={t.assignee?.id ?? ''} onChange={(e) => patchTicket.mutate({ assigneeUserId: e.target.value || null })}>
            <option value="">Unassigned</option>
            {users.data
              ?.filter((u) => !u.disabled || u.id === t.assignee?.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.email}
                </option>
              ))}
          </select>
          <span className="spacer" />
          <span className="muted small" title={dateTime(t.createdAt)}>
            Reported {relativeTime(t.reportedAt)}
            {t.reporter.email ? ` by ${t.reporter.email}` : ''}
          </span>
        </div>
        {t.uploadState !== 'complete' && (
          <div className="notice warn">
            {t.uploadState === 'pending' ? 'Attachments are still uploading from the device.' : 'The device stopped uploading before every attachment arrived.'}
          </div>
        )}
      </div>

      <div className="grid-2">
        <div className="stack">
          <section className="card">
            <div className="card-body">
              <div className="description">{t.description.trim() || <span className="muted">No description.</span>}</div>
            </div>
          </section>

          {(screenshot || video) && (
            <section className="card">
              <div className="card-body media">
                {screenshot && <Screenshot a={screenshot} />}
                {video && <Video a={video} />}
              </div>
            </section>
          )}

          {logs && <Logs a={logs} />}

          <section className="card">
            <div className="card-header">
              <h2>Activity</h2>
            </div>
            <div className="card-body stack">
              <Timeline events={d.events} typeLabel={typeLabel} users={users.data ?? []} />
              <CommentBox ticketId={id} onDone={update} />
            </div>
          </section>
        </div>

        <aside className="stack">
          <EscalatePanel d={d} integrations={integrations.data ?? []} onEscalate={(iid) => escalate.mutate(iid)} busy={escalate.isPending} isAdmin={user?.role === 'admin'} />

          <section className="card">
            <div className="card-header">
              <h2>Device</h2>
            </div>
            <div className="card-body">
              <table className="meta-table">
                <tbody>
                  <Row k="App" v={`${t.app.name ?? t.app.id} ${t.app.version} (${t.app.build})`} />
                  <Row k="Bundle" v={t.app.id} mono />
                  <Row k="Build" v={RELEASE_LABEL[t.releaseType]} />
                  <Row k="Device" v={`${t.device.manufacturer ? `${t.device.manufacturer} ` : ''}${t.device.model}`} />
                  <Row k="OS" v={`${osName(t.platform)} ${t.device.osVersion}`} />
                  {t.device.screen && <Row k="Screen" v={`${t.device.screen.width}×${t.device.screen.height} @${t.device.screen.scale}x ${t.device.screen.orientation}`} />}
                  {t.device.locale && <Row k="Locale" v={`${t.device.locale}${t.device.timeZone ? ` · ${t.device.timeZone}` : ''}`} />}
                  {t.device.network && <Row k="Network" v={t.device.network} />}
                  {t.device.memory?.appMB !== undefined && <Row k="Memory" v={`${Math.round(t.device.memory.appMB)} MB used${t.device.memory.totalMB ? ` of ${Math.round(t.device.memory.totalMB / 1024)} GB` : ''}`} />}
                  {t.device.battery !== undefined && <Row k="Battery" v={`${Math.round(t.device.battery * 100)}%${t.device.charging ? ', charging' : ''}${t.device.lowPower ? ', low power' : ''}`} />}
                  {t.device.thermal && t.device.thermal !== 'nominal' && <Row k="Thermal" v={t.device.thermal} />}
                  {t.device.darkMode !== undefined && <Row k="Appearance" v={t.device.darkMode ? 'Dark' : 'Light'} />}
                  {t.device.screenReader && <Row k="Screen reader" v="On" />}
                  {t.device.fontScale && t.device.fontScale !== 1 && <Row k="Text size" v={`${t.device.fontScale}×`} />}
                  <Row k="SDK" v={`${t.sdk.name} ${t.sdk.version}${t.sdk.wrapper ? ` (${t.sdk.wrapper} ${t.sdk.wrapperVersion ?? ''})` : ''}`} />
                  {t.trigger && <Row k="Opened by" v={t.trigger} />}
                </tbody>
              </table>
            </div>
          </section>

          {Object.keys(t.custom).length > 0 && (
            <section className="card">
              <div className="card-header">
                <h2>Metadata</h2>
              </div>
              <div className="card-body">
                <table className="meta-table">
                  <tbody>
                    {Object.entries(t.custom).map(([k, v]) => (
                      <Row key={k} k={k} v={v} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {Object.keys(t.stats).length > 0 && (
            <section className="card">
              <div className="card-header">
                <h2>Capture</h2>
              </div>
              <div className="card-body">
                <table className="meta-table">
                  <tbody>
                    {t.stats.captureMode && <Row k="Mode" v={`${t.stats.captureMode}${t.stats.snapshotRenderer ? ` · ${t.stats.snapshotRenderer}` : ''}`} />}
                    {t.stats.captureMsP50 !== undefined && <Row k="Frame cost" v={`${t.stats.captureMsP50.toFixed(1)} ms p50 · ${t.stats.captureMsP95?.toFixed(1) ?? '?'} ms p95`} />}
                    {t.stats.effectiveFps !== undefined && <Row k="Frame rate" v={`${t.stats.effectiveFps.toFixed(1)} fps`} />}
                    {t.stats.ringBytes !== undefined && <Row k="Buffer" v={`${bytes(t.stats.ringBytes)} · ${t.stats.bufferedSeconds ?? '?'} s`} />}
                    {t.stats.composeMs !== undefined && <Row k="Encode" v={`${Math.round(t.stats.composeMs)} ms`} />}
                    {t.stats.videoLost && <Row k="Video" v="Lost (encoding failed on device)" />}
                    {t.stats.crashLoopDowngrades ? <Row k="Downgrades" v={String(t.stats.crashLoopDowngrades)} /> : null}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <ShareLinks attachments={d.attachments} ticketId={id} />

          {user?.role === 'admin' && (
            <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
              Delete ticket
            </button>
          )}
        </aside>
      </div>

      {confirmDelete && (
        <Dialog
          title={`Delete ${t.key}?`}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>The report, its screenshot, video and history are removed for good. Issues already created elsewhere stay.</p>
        </Dialog>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <tr>
      <td>{k}</td>
      <td className={mono ? 'mono' : undefined} style={{ wordBreak: 'break-word' }}>
        {v}
      </td>
    </tr>
  );
}

function TitleEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const commit = () => {
    const next = v.trim();
    if (next && next !== value) onSave(next);
    else setV(value);
  };
  return (
    <input
      className="title-input"
      aria-label="Title"
      value={v}
      maxLength={200}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

function Screenshot({ a }: { a: AttachmentView }) {
  const [open, setOpen] = useState(false);
  return (
    <figure>
      <img className="shot" src={a.url} alt="Screenshot" onClick={() => setOpen(true)} />
      <figcaption>
        <span>Screenshot</span>
        <a href={a.url} target="_blank" rel="noreferrer">
          {bytes(a.sizeBytes)}
        </a>
      </figcaption>
      {open && (
        <div className="backdrop lightbox" onClick={() => setOpen(false)}>
          <img src={a.url} alt="Screenshot, full size" />
        </div>
      )}
    </figure>
  );
}

function Video({ a }: { a: AttachmentView }) {
  const [rate, setRate] = useState(1);
  return (
    <figure>
      <video
        className="clip"
        src={a.url}
        controls
        playsInline
        preload="metadata"
        ref={(el) => {
          if (el) el.playbackRate = rate;
        }}
      />
      <figcaption>
        <span>{a.durationMs ? `${(a.durationMs / 1000).toFixed(0)} s recording` : 'Recording'}</span>
        <span className="row" style={{ gap: 4 }}>
          {[0.5, 1, 2].map((r) => (
            <button key={r} type="button" className={`small ${rate === r ? 'primary' : 'ghost'}`} onClick={() => setRate(r)}>
              {r}×
            </button>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}

function Logs({ a }: { a: AttachmentView }) {
  const logs = useQuery({ queryKey: ['logs', a.id], queryFn: async () => (await fetch(a.url, { credentials: 'same-origin' })).text() });
  return (
    <section className="card">
      <div className="card-header">
        <h2>Logs</h2>
        <a href={a.url} target="_blank" rel="noreferrer" className="small">
          Raw
        </a>
      </div>
      <div className="card-body" style={{ maxHeight: 320, overflowY: 'auto' }}>
        <pre>{logs.data ?? 'Loading…'}</pre>
      </div>
    </section>
  );
}

function describe(e: TicketEventView, typeLabel: (id: string) => string, userName: (id: unknown) => string): string {
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case 'created':
      return `Reported from the app${d.trigger ? ` (${String(d.trigger)})` : ''}`;
    case 'completed':
      return 'Upload finished';
    case 'incomplete':
      return `Upload never finished${Array.isArray(d.missing) && d.missing.length ? ` — missing ${d.missing.join(', ')}` : ''}`;
    case 'status_changed':
      return `Status ${STATUS_LABEL[d.from as TicketStatus] ?? d.from} → ${STATUS_LABEL[d.to as TicketStatus] ?? d.to}`;
    case 'assigned':
      return d.to ? `Assigned to ${userName(d.to)}` : 'Unassigned';
    case 'type_changed':
      return `Type ${typeLabel(String(d.from))} → ${typeLabel(String(d.to))}`;
    case 'title_changed':
      return 'Renamed';
    case 'comment':
      return 'Commented';
    case 'escalation_suggested':
      return `Routing suggests ${String(d.integration ?? 'an integration')}`;
    case 'escalation_queued':
      return `Escalation to ${String(d.integration ?? 'an integration')} queued`;
    case 'escalated':
      return `Sent to ${String(d.integration ?? 'an integration')}`;
    case 'escalation_failed':
      return `Couldn't send to ${String(d.integration ?? 'an integration')}: ${String(d.error ?? '')}`;
    case 'share_link_created':
      return `Public link created for the ${String(d.attachment)}${d.integration ? ` (for ${String(d.integration)})` : ''}`;
    case 'share_link_revoked':
      return 'Public link revoked';
    default:
      return e.kind;
  }
}

function Timeline({ events, typeLabel, users }: { events: TicketEventView[]; typeLabel: (id: string) => string; users: { id: string; name: string | null; email: string }[] }) {
  const userName = (id: unknown) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.name ?? u.email) : 'someone';
  };
  return (
    <ul className="timeline">
      {events.map((e) => {
        const who = e.actor.type === 'user' ? (e.actor.name ?? 'Someone') : e.actor.type === 'sdk' ? 'Device' : e.actor.type === 'integration' ? 'Integration' : 'Snitch';
        const url = typeof e.data.url === 'string' ? e.data.url : null;
        return (
          <li key={e.id}>
            <Avatar name={who} />
            <div>
              <div>
                <strong>{who}</strong> <span className="muted">· {describe(e, typeLabel, userName)}</span>
                {url && (
                  <>
                    {' '}
                    <a href={url} target="_blank" rel="noreferrer">
                      open <External className="icon-inline" />
                    </a>
                  </>
                )}
              </div>
              <div className="when" title={dateTime(e.createdAt)}>
                {relativeTime(e.createdAt)}
              </div>
              {e.kind === 'comment' && <div className="comment-body">{String(e.data.body ?? '')}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CommentBox({ ticketId, onDone }: { ticketId: string; onDone: (d: TicketDetail) => void }) {
  const [body, setBody] = useState('');
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => post<TicketDetail>(`/tickets/${ticketId}/comments`, { body: body.trim() }),
    onSuccess: (d) => {
      setBody('');
      onDone(d);
    },
    onError: (e) => toast(errorText(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (body.trim()) add.mutate();
  };
  return (
    <form className="stack" onSubmit={submit}>
      <textarea
        rows={3}
        placeholder="Add an internal note…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="row">
        <span className="muted small">⌘/Ctrl + Enter to post</span>
        <span className="spacer" />
        <button type="submit" disabled={!body.trim() || add.isPending}>
          Comment
        </button>
      </div>
    </form>
  );
}

function EscalatePanel({ d, integrations, onEscalate, busy, isAdmin }: { d: TicketDetail; integrations: IntegrationView[]; onEscalate: (id: string) => void; busy: boolean; isAdmin: boolean }) {
  const byIntegration = new Map(d.escalations.map((e) => [e.integrationId, e]));
  const suggested = new Set(d.suggestedIntegrationIds);
  const enabled = integrations.filter((i) => i.enabled || byIntegration.has(i.id));
  return (
    <section className="card">
      <div className="card-header">
        <h2>Escalate</h2>
      </div>
      <div className="card-body side-section">
        {enabled.length === 0 && (
          <div className="muted small">
            No integrations yet.{' '}
            {isAdmin && (
              <Link href={`/projects/${d.project.id}/settings/integrations`} className="small">
                Connect GitHub, email or a webhook
              </Link>
            )}
          </div>
        )}
        {enabled.map((i) => {
          const esc = byIntegration.get(i.id);
          return (
            <div key={i.id} className={`integration-row${suggested.has(i.id) && !esc ? ' suggested' : ''}`}>
              <span className="row" style={{ minWidth: 0 }}>
                <IntegrationIcon kind={i.kind} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.name}</span>
              </span>
              {esc && esc.state !== 'failed' ? (
                <span className="row">
                  <EscalationPill state={esc.state} />
                  {esc.externalUrl && (
                    <a href={esc.externalUrl} target="_blank" rel="noreferrer" aria-label="Open">
                      <External className="icon-inline" />
                    </a>
                  )}
                </span>
              ) : (
                <button type="button" className="small" onClick={() => onEscalate(i.id)} disabled={busy || !i.enabled} title={esc?.lastError ?? undefined}>
                  <Send /> {esc ? 'Retry' : 'Send'}
                </button>
              )}
            </div>
          );
        })}
        {d.escalations
          .filter((e) => e.state === 'failed' && e.lastError)
          .map((e) => (
            <div key={e.id} className="notice danger small">
              {e.integrationName}: {e.lastError}
            </div>
          ))}
      </div>
    </section>
  );
}

function ShareLinks({ attachments, ticketId }: { attachments: AttachmentView[]; ticketId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [created, setCreated] = useState<{ url: string; name: string } | null>(null);
  const create = useMutation({
    mutationFn: (a: AttachmentView) => post<{ url: string }>(`/attachments/${a.id}/share-links`, { expiresInDays: 30 }).then((r) => ({ ...r, name: a.name })),
    onSuccess: (r) => {
      setCreated({ url: r.url, name: r.name });
      void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
    },
    onError: (e) => toast(errorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/share-links/${id}`),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) }), toast('Link revoked')),
  });
  const stored = attachments.filter((a) => a.stored);
  if (stored.length === 0) return null;
  const now = Date.now();
  return (
    <section className="card">
      <div className="card-header">
        <h2>Public links</h2>
      </div>
      <div className="card-body side-section">
        <p className="muted small" style={{ margin: 0 }}>
          Anyone with a link can open that file until it expires (30 days) or you revoke it.
        </p>
        {stored.map((a) => {
          const live = a.shareLinks.filter((l) => !l.revokedAt && (!l.expiresAt || l.expiresAt > now));
          return (
            <div key={a.id} className="stack" style={{ gap: 6 }}>
              <div className="row">
                <span style={{ textTransform: 'capitalize' }}>{a.name}</span>
                <span className="muted small">{bytes(a.sizeBytes)}</span>
                <span className="spacer" />
                <button type="button" className="small" onClick={() => create.mutate(a)} disabled={create.isPending}>
                  <LinkIcon /> New link
                </button>
              </div>
              {live.map((l) => (
                <div key={l.id} className="row small muted">
                  <span>Link from {relativeTime(l.createdAt)}</span>
                  <span>{l.expiresAt ? `· expires ${relativeTime(l.expiresAt)}` : ''}</span>
                  <span className="spacer" />
                  <button type="button" className="small ghost danger" onClick={() => revoke.mutate(l.id)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {created && (
        <Dialog
          title={`Public link to the ${created.name}`}
          onClose={() => setCreated(null)}
          footer={
            <button type="button" className="primary" onClick={() => setCreated(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            <div className="secret-box">{created.url}</div>
            <span className="muted small">Copy it now — only a hash is stored, so it can't be shown again.</span>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(created.url).then(() => toast('Copied'))}>
              Copy link
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
