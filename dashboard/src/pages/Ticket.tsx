/**
 * One ticket: what the tester said and saw, where it came from, what happened
 * to it since, and where to send it next.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  TICKET_STATUSES,
  TIMELINE_ATTACHMENT,
  TIMELINE_CONTENT_TYPE,
  type AttachmentView,
  type IntegrationView,
  type SimilarTicketView,
  type TicketDetail,
  type TicketEventView,
  type TicketPatch,
  type TicketStatus,
} from '@snitch/contract';
import { del, errorText, get, patch, post } from '../lib/api';
import { RELEASE_LABEL, STATUS_LABEL, bytes, dateTime, osName, relativeTime } from '../lib/format';
import { qk, useAttachmentText, useIntegrations, useProjects, useUsers } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { Alert, ArrowLeft, Chevron, External, Link as LinkIcon, Send } from '../components/icons';
import { Avatar, CopyButton, Dialog, EscalationPill, IntegrationIcon, StatusPill, useToast } from '../components/ui';
import { VideoPlayer, type Playhead } from '../components/Player';
import { TimelinePanel } from '../components/Timeline';

/** The attachment an SDK sends with a crash follow-up (docs/sdk-spec.md §11.8). */
const CRASH_ATTACHMENT = 'crash';
const TEXT_TYPES = new Set(['text/plain', 'application/x-ndjson']);

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
  const [fixedInDialog, setFixedInDialog] = useState<'resolve' | 'edit' | null>(null);
  const projects = useProjects();

  if (ticket.isLoading) return <div className="page empty">Loading…</div>;
  if (ticket.isError || !ticket.data) return <div className="page empty error-text">{ticket.error ? errorText(ticket.error) : 'Not found'}</div>;
  const d = ticket.data;
  const t = d.ticket;
  const typeLabel = (tid: string) => d.project.reportTypes.find((r) => r.id === tid)?.label ?? tid;
  const screenshot = d.attachments.find((a) => a.stored && a.contentType.startsWith('image/'));
  const video = d.attachments.find((a) => a.stored && a.contentType === 'video/mp4');
  const timeline = d.attachments.find((a) => a.stored && a.name === TIMELINE_ATTACHMENT && a.contentType === TIMELINE_CONTENT_TYPE);
  const crash = d.attachments.find((a) => a.stored && a.name === CRASH_ATTACHMENT);
  const logs = d.attachments.filter((a) => a.stored && a !== timeline && a !== crash && TEXT_TYPES.has(a.contentType));
  const onStatus = (status: TicketStatus) => (status === 'resolved' ? setFixedInDialog('resolve') : patchTicket.mutate({ status }));

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
          <select aria-label="Status" value={t.status} onChange={(e) => onStatus(e.target.value as TicketStatus)}>
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
          {t.trigger === 'crash' && (
            <span className="pill warn" title="Sent from the prompt an app shows on the launch after an unexpected exit">
              <Alert className="icon-inline" /> Reported after a crash
            </span>
          )}
          {t.status === 'resolved' ? (
            <button type="button" className="pill resolved pill-button" onClick={() => setFixedInDialog('edit')} title="Change the build this is fixed in">
              {t.fixedIn ? `Fixed in ${t.fixedIn}` : 'Add fixed-in build'}
            </button>
          ) : (
            t.fixedIn && <span className="pill">Fixed in {t.fixedIn}</span>
          )}
          {t.duplicateOfId && <DuplicateOf id={t.duplicateOfId} events={d.events} />}
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

          <ReportMedia screenshot={screenshot} video={video} timeline={timeline} reportedAt={t.reportedAt} />

          {crash && <CrashReport a={crash} defaultOpen={t.trigger === 'crash'} />}

          {logs.map((a) => (
            <Logs key={a.id} a={a} />
          ))}

          <section className="card">
            <div className="card-header">
              <h2>Activity</h2>
            </div>
            <div className="card-body stack">
              <ActivityList events={d.events} typeLabel={typeLabel} users={users.data ?? []} />
              <CommentBox ticketId={id} onDone={update} />
            </div>
          </section>
        </div>

        <aside className="stack">
          <EscalatePanel d={d} integrations={integrations.data ?? []} onEscalate={(iid) => escalate.mutate(iid)} busy={escalate.isPending} isAdmin={user?.role === 'admin'} />

          <SimilarPanel d={d} onDone={update} />

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
                  {t.screen && <Row k="Screen" v={t.screen} />}
                  <Row k="Device" v={`${t.device.manufacturer ? `${t.device.manufacturer} ` : ''}${t.device.model}`} />
                  <Row k="OS" v={`${osName(t.platform)} ${t.device.osVersion}`} />
                  {t.device.screen && <Row k="Display" v={`${t.device.screen.width}×${t.device.screen.height} @${t.device.screen.scale}x ${t.device.screen.orientation}`} />}
                  {t.device.locale && <Row k="Locale" v={`${t.device.locale}${t.device.timeZone ? ` · ${t.device.timeZone}` : ''}`} />}
                  {t.device.network && <Row k="Network" v={t.device.network} />}
                  {t.device.memory?.appMB !== undefined && <Row k="Memory" v={`${Math.round(t.device.memory.appMB)} MB used${t.device.memory.totalMB ? ` of ${Math.round(t.device.memory.totalMB / 1024)} GB` : ''}`} />}
                  {t.device.battery !== undefined && <Row k="Battery" v={`${Math.round(t.device.battery * 100)}%${t.device.charging ? ', charging' : ''}${t.device.lowPower ? ', low power' : ''}`} />}
                  {t.device.thermal && t.device.thermal !== 'nominal' && <Row k="Thermal" v={t.device.thermal} />}
                  {t.device.darkMode !== undefined && <Row k="Appearance" v={t.device.darkMode ? 'Dark' : 'Light'} />}
                  {t.device.screenReader && <Row k="Screen reader" v="On" />}
                  {t.device.fontScale && t.device.fontScale !== 1 && <Row k="Text size" v={`${t.device.fontScale}×`} />}
                  <Row k="SDK" v={`${t.sdk.name} ${t.sdk.version}${t.sdk.wrapper ? ` (${t.sdk.wrapper} ${t.sdk.wrapperVersion ?? ''})` : ''}`} />
                  {t.trigger && <Row k="Opened by" v={t.trigger === 'crash' ? 'crash prompt, after an unexpected exit' : t.trigger} />}
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

      {fixedInDialog && (
        <FixedInDialog
          title={fixedInDialog === 'resolve' ? `Resolve ${t.key}` : 'Fixed in build'}
          action={fixedInDialog === 'resolve' ? 'Resolve' : 'Save'}
          initial={t.fixedIn}
          notify={fixedInDialog === 'resolve' && t.reporter.email && projects.data?.find((p) => p.id === d.project.id)?.notifyReporters ? t.reporter.email : null}
          busy={patchTicket.isPending}
          onClose={() => setFixedInDialog(null)}
          onSave={(fixedIn) =>
            patchTicket.mutate(fixedInDialog === 'resolve' ? { status: 'resolved', fixedIn } : { fixedIn }, { onSuccess: () => setFixedInDialog(null) })
          }
        />
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

/** A one-line title that wraps instead of scrolling sideways (a textarea sized to its text; Enter saves). */
function TitleEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [v]);
  const commit = () => {
    const next = v.trim();
    if (next && next !== value) onSave(next);
    else setV(value);
  };
  return (
    <textarea
      ref={ref}
      className="title-input"
      aria-label="Title"
      rows={1}
      value={v}
      maxLength={200}
      onChange={(e) => setV(e.target.value.replace(/\s*\n\s*/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
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

/**
 * Screenshot, clip and timeline. The playhead lives here rather than on the page,
 * so playback re-renders only these cards.
 */
function ReportMedia({ screenshot, video, timeline, reportedAt }: { screenshot?: AttachmentView; video?: AttachmentView; timeline?: AttachmentView; reportedAt: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playhead, setPlayhead] = useState<Playhead | null>(null);
  const seek = useCallback((seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = seconds;
    setPlayhead({ time: v.currentTime, playing: !v.paused && !v.ended });
  }, []);
  return (
    <>
      {(screenshot || video) && (
        <section className="card">
          <div className="card-body media">
            {screenshot && <Screenshot a={screenshot} />}
            {video && <VideoPlayer a={video} videoRef={videoRef} playhead={playhead} onPlayhead={setPlayhead} />}
          </div>
        </section>
      )}
      {timeline && <TimelinePanel a={timeline} reportedAt={reportedAt} playhead={playhead} onSeek={video ? seek : null} />}
    </>
  );
}

function Logs({ a }: { a: AttachmentView }) {
  const logs = useAttachmentText(a);
  return (
    <section className="card">
      <div className="card-header">
        <h2>{a.name === 'logs' ? 'Logs' : a.name}</h2>
        <a href={a.url} target="_blank" rel="noreferrer" className="small">
          Raw
        </a>
      </div>
      <div className="card-body" style={{ maxHeight: 320, overflowY: 'auto' }}>
        <pre>{logs.isError ? errorText(logs.error) : (logs.data ?? 'Loading…')}</pre>
      </div>
    </section>
  );
}

/** MetricKit diagnostics are JSON; Android traces are plain text. */
function prettyCrash(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function CrashReport({ a, defaultOpen }: { a: AttachmentView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const text = useAttachmentText(a, open);
  const pretty = useMemo(() => (text.data === undefined ? null : prettyCrash(text.data)), [text.data]);
  const bodyId = `crash-${a.id}`;
  return (
    <section className="card">
      <div className="card-header">
        <h2>
          <button type="button" className="disclosure-button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            <Chevron className={`icon-inline disclosure${open ? ' open' : ''}`} /> Crash report
          </button>
        </h2>
        <span className="row">
          <span className="muted small">{bytes(a.sizeBytes)}</span>
          {open && pretty !== null && <CopyButton text={pretty} />}
          <a href={a.url} target="_blank" rel="noreferrer" className="small">
            Raw
          </a>
        </span>
      </div>
      {open && (
        <div id={bodyId} className="card-body" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <pre>{text.isError ? errorText(text.error) : (pretty ?? 'Loading…')}</pre>
        </div>
      )}
    </section>
  );
}

function FixedInDialog({
  title,
  action,
  initial,
  notify,
  busy,
  onSave,
  onClose,
}: {
  title: string;
  action: string;
  initial: string | null;
  /** The reporter's address, when resolving emails them. */
  notify: string | null;
  busy: boolean;
  onSave: (fixedIn: string | null) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="fixed-in-form" className="primary" disabled={busy}>
            {action}
          </button>
        </>
      }
    >
      <form
        id="fixed-in-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value.trim() || null);
        }}
      >
        <label className="field">
          Fixed in build (optional)
          <input value={value} onChange={(e) => setValue(e.target.value)} maxLength={64} placeholder="e.g. 0.6.1 (18)" autoFocus />
          <span className="field-hint">The version and build the fix ships in, so testers know which build to check.</span>
        </label>
        {notify && <div className="notice small">{notify} will get an email that this is fixed{value.trim() ? ` in ${value.trim()}` : ''}.</div>}
      </form>
    </Dialog>
  );
}

/** Link to the ticket this one duplicates; the key comes from the duplicate_marked event when there is one. */
function DuplicateOf({ id, events }: { id: string; events: TicketEventView[] }) {
  const fromEvent = events.findLast((e) => e.kind === 'duplicate_marked' && e.data.duplicateOfId === id)?.data.key;
  const known = typeof fromEvent === 'string' ? fromEvent : null;
  const original = useQuery({ queryKey: qk.ticket(id), queryFn: () => get<TicketDetail>(`/tickets/${id}`), enabled: !known });
  return (
    <Link href={`/tickets/${id}`} className="pill">
      Duplicate of {known ?? original.data?.ticket.key ?? 'another ticket'}
    </Link>
  );
}

function SimilarPanel({ d, onDone }: { d: TicketDetail; onDone: (d: TicketDetail) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<SimilarTicketView | null>(null);
  const mark = useMutation({
    mutationFn: (s: SimilarTicketView) => patch<TicketDetail>(`/tickets/${d.ticket.id}`, { duplicateOfId: s.id, status: 'duplicate' } satisfies TicketPatch),
    onSuccess: (data, s) => {
      onDone(data);
      void qc.invalidateQueries({ queryKey: qk.ticket(s.id) });
      setConfirm(null);
      toast(`Marked as a duplicate of ${s.key}`);
    },
    onError: (e) => toast(errorText(e)),
  });
  if (d.similar.length === 0) return null;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Similar tickets</h2>
      </div>
      <div className="card-body side-section">
        {d.similar.map((s) => (
          <div key={s.id} className="similar">
            <div className="row">
              <Link href={`/tickets/${s.id}`} className="mono small">
                {s.key}
              </Link>
              <StatusPill status={s.status} />
              <span className="spacer" />
              <span className="similar-score" title="How alike the two reports are">
                {Math.round(s.score * 100)}%
              </span>
            </div>
            <Link href={`/tickets/${s.id}`} className="similar-title">
              {s.title}
            </Link>
            {s.reasons.length > 0 && <div className="muted small">{s.reasons.join(' · ')}</div>}
            {d.ticket.duplicateOfId === s.id ? (
              <span className="muted small">This ticket is marked as its duplicate.</span>
            ) : (
              <div>
                <button type="button" className="small" onClick={() => setConfirm(s)}>
                  Mark as duplicate of this
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {confirm && (
        <Dialog
          title={`Mark ${d.ticket.key} as a duplicate?`}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => mark.mutate(confirm)} disabled={mark.isPending}>
                Mark as duplicate
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            {d.ticket.key} gets the status Duplicate and links to {confirm.key} ({confirm.title}). Follow-up happens on {confirm.key}.
          </p>
        </Dialog>
      )}
    </section>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function describe(e: TicketEventView, typeLabel: (id: string) => string, userName: (id: unknown) => string): ReactNode {
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
    case 'external_status_changed': {
      const by = str(d.author) ? ` by @${str(d.author)}` : '';
      if (d.state !== 'closed') return `Reopened on GitHub${by}`;
      const reason = d.stateReason === 'not_planned' ? ' as not planned' : d.stateReason === 'duplicate' ? ' as a duplicate' : '';
      return `Closed on GitHub${by}${reason}`;
    }
    case 'external_comment':
      return 'commented on GitHub';
    case 'external_pull_request': {
      const pr = `pull request #${String(d.number ?? '?')}${str(d.title) ? ` “${str(d.title)}”` : ''}`;
      if (d.state === 'merged') return `Merged ${pr}, which fixes the issue`;
      if (d.state === 'closed') return `Closed ${pr} without merging`;
      return `Opened ${pr}, which says it fixes the issue`;
    }
    case 'notification_sent':
      return `Emailed the ${str(d.to) || 'recipient'}${str(d.email) ? ` (${str(d.email)})` : ''}`;
    case 'media_upload_failed':
      return `Couldn't put the media on GitHub for ${str(d.integration) || 'the issue'}, so it links to Snitch: ${str(d.error)}`;
    case 'notification_failed':
      return `Couldn't email the ${str(d.to) || 'recipient'}${str(d.email) ? ` (${str(d.email)})` : ''}${str(d.error) ? `: ${str(d.error)}` : ''}`;
    case 'duplicate_marked':
      return (
        <>
          Marked as a duplicate of{' '}
          {str(d.duplicateOfId) ? (
            <Link href={`/tickets/${str(d.duplicateOfId)}`} className="mono">
              {str(d.key) || 'another ticket'}
            </Link>
          ) : (
            str(d.key) || 'another ticket'
          )}
        </>
      );
    default:
      return e.kind;
  }
}

function actorName(e: TicketEventView): string {
  if (e.kind === 'external_comment') return str(e.data.author) ? `@${str(e.data.author)}` : 'GitHub';
  if (e.kind === 'external_status_changed') return 'GitHub';
  if (e.kind === 'external_pull_request') return str(e.data.author) ? `@${str(e.data.author)}` : 'GitHub';
  if (e.actor.type === 'user') return e.actor.name ?? 'Someone';
  if (e.actor.type === 'sdk') return 'Device';
  if (e.actor.type === 'integration') return 'Integration';
  return 'Snitch';
}

function ActivityList({ events, typeLabel, users }: { events: TicketEventView[]; typeLabel: (id: string) => string; users: { id: string; name: string | null; email: string }[] }) {
  const userName = (id: unknown) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.name ?? u.email) : 'someone';
  };
  return (
    <ul className="timeline">
      {events.map((e) => {
        const who = actorName(e);
        const url = typeof e.data.url === 'string' ? e.data.url : null;
        const body = e.kind === 'comment' || e.kind === 'external_comment' ? str(e.data.body) : null;
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
              {body !== null && <div className={`comment-body${e.kind === 'external_comment' ? ' external' : ''}`}>{body}</div>}
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
