import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_TOKEN_SCOPES, type ApiTokenCreated, type ApiTokenScope, type ApiTokenView } from '@snitch/contract';
import { del, errorText, get, post } from '../lib/api';
import { dateTime, relativeTime } from '../lib/format';
import { qk } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { CopyButton, Dialog, Snippet, useToast } from '../components/ui';

export const SCOPE_LABEL: Record<ApiTokenScope, string> = {
  'tickets:read': 'Read tickets and download their screenshots, videos and logs; see the team and the builds testers run',
  'tickets:write': 'Comment on tickets, change their status, assignee, type and title, mark duplicates, and open them in integrations such as GitHub',
};

const EXPIRY = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 366 },
  { label: 'Never', days: null },
] as const;

/** Personal API tokens for the snitch CLI, its MCP server and scripts. */
export function Tokens() {
  const { user } = useAuth();
  const [all, setAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const tokens = useQuery({ queryKey: qk.tokens(all), queryFn: () => get<ApiTokenView[]>(`/tokens${all ? '?all=true' : ''}`) });
  const revoke = useMutation({
    mutationFn: (t: ApiTokenView) => del(`/tokens/${t.id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tokens'] }),
    onError: (e) => toast(errorText(e)),
  });
  const now = Date.now();
  const live = (t: ApiTokenView) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now);

  return (
    <div className="page">
      <div className="page-header">
        <h1>API tokens</h1>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          New token
        </button>
      </div>
      <p className="muted">
        Tokens let the <code>snitch</code> CLI, its MCP server for coding agents, and your scripts read tickets as you. The easiest way to get one is to run{' '}
        <code>npx snitch-cli login</code> and approve it here.
      </p>
      {user?.role === 'admin' && (
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show everyone’s live tokens
        </label>
      )}
      <div className="card">
        <div className="table-scroll">
          <table className="list">
            <thead>
              <tr>
                <th>Name</th>
                {all && <th>Owner</th>}
                <th>Can</th>
                <th>Last used</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.data?.length === 0 && (
                <tr>
                  <td colSpan={all ? 6 : 5} className="muted">
                    No tokens yet.
                  </td>
                </tr>
              )}
              {tokens.data?.map((t) => (
                <tr key={t.id} style={live(t) ? undefined : { opacity: 0.55 }}>
                  <td>
                    <div>{t.name}</div>
                    <div className="muted small mono">
                      {t.prefix}
                      {t.viaDevice ? ' · from snitch login' : ''}
                    </div>
                  </td>
                  {all && <td>{t.user?.name ?? t.user?.email}</td>}
                  <td>{t.scopes.map((s) => (s === 'tickets:read' ? 'read' : 'write')).join(' + ')}</td>
                  <td title={t.lastUsedAt ? dateTime(t.lastUsedAt) : undefined}>
                    {t.lastUsedAt ? relativeTime(t.lastUsedAt) : 'Never'}
                    {t.lastUsedIp && <div className="muted small mono">{t.lastUsedIp}</div>}
                  </td>
                  <td>{t.revokedAt ? 'Revoked' : t.expiresAt === null ? 'Never' : t.expiresAt <= now ? 'Expired' : dateTime(t.expiresAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {live(t) && (
                      <button type="button" className="small ghost" disabled={revoke.isPending} onClick={() => confirm(`Revoke “${t.name}”? Anything using it stops working.`) && revoke.mutate(t)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {creating && <CreateToken onClose={() => setCreating(false)} onCreated={(c) => (setCreating(false), setCreated(c))} />}
      {created && <TokenCreated created={created} onClose={() => setCreated(null)} />}
    </div>
  );
}

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: (c: ApiTokenCreated) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['tickets:read']);
  const [days, setDays] = useState<number | null>(90);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<ApiTokenCreated>('/tokens', { name, scopes, expiresInDays: days }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['tokens'] });
      onCreated(c);
    },
    onError: (e) => setError(errorText(e)),
  });
  const submit = (e: FormEvent) => (e.preventDefault(), create.mutate());
  const toggle = (s: ApiTokenScope, on: boolean) => setScopes((cur) => (on ? [...new Set([...cur, s])] : cur.filter((x) => x !== s)));
  return (
    <Dialog
      title="New API token"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-token" className="primary" disabled={create.isPending || scopes.length === 0}>
            Create
          </button>
        </>
      }
    >
      <form id="new-token" className="form" onSubmit={submit}>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="CI, laptop, triage agent…" required maxLength={80} autoFocus />
        </label>
        <fieldset className="field">
          <legend>It can</legend>
          {API_TOKEN_SCOPES.map((s) => (
            <label key={s} className="check block">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => toggle(s, e.target.checked)} /> {SCOPE_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <label className="field">
          Expires after
          <select value={days === null ? 'never' : String(days)} onChange={(e) => setDays(e.target.value === 'never' ? null : Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.label} value={x.days === null ? 'never' : String(x.days)}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function TokenCreated({ created, onClose }: { created: ApiTokenCreated; onClose: () => void }) {
  return (
    <Dialog
      title={`“${created.view.name}” is ready`}
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="form">
        <div className="notice warn">Copy it now: Snitch only keeps a hash and can’t show it again.</div>
        <div className="secret-box">{created.token}</div>
        <div>
          <CopyButton text={created.token} label="Copy token" />
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Use it as <code>Authorization: Bearer …</code>, set it as <code>SNITCH_TOKEN</code> in CI, or give it to the CLI (it asks you to paste it, so it stays out of your shell
          history):
        </p>
        <Snippet code={`npx snitch-cli login --server ${location.origin} --with-token`} />
      </div>
    </Dialog>
  );
}
