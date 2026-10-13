import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuditEntryView, JobView, ServerInfo } from '@snitch/contract';
import { errorText, get, post } from '../lib/api';
import { bytes, dateTime, relativeTime } from '../lib/format';
import { qk } from '../lib/queries';
import { Empty, useToast } from '../components/ui';

/** Version, storage, mail and backups at a glance; backups change, so this one refreshes. */
function ServerCard() {
  const server = useQuery({ queryKey: qk.server, queryFn: () => get<ServerInfo>('/server'), staleTime: 0, refetchInterval: 60_000 });
  const s = server.data;
  if (!s) return null;
  const b = s.backup;
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Server">
      <div className="card-header">
        <h2>Server</h2>
        <span className="muted small mono">v{s.version}</span>
      </div>
      <div className="card-body server-grid">
        <div className="kv">
          <span>Public URL</span>
          <span className="mono">{s.publicUrl}</span>
        </div>
        <div className="kv">
          <span>Storage</span>
          <span>{s.storage === 's3' ? 'S3' : 'Local disk'}</span>
        </div>
        <div className="kv">
          <span>Email</span>
          <span>{s.mail === 'smtp' ? 'SMTP' : <span className="warn-text">Not configured (server log only)</span>}</span>
        </div>
        <div className="kv">
          <span>Backups</span>
          <span>
            {b.enabled ? (
              <>
                Every {b.intervalHours} h to {b.target === 's3' ? 'the backup S3 bucket' : s.storage === 's3' ? 'the S3 blob store, under backups/' : 'the data volume, under backups/'}, keeping{' '}
                {b.keep}
              </>
            ) : (
              <span className="warn-text">Off (set SNITCH_BACKUP_INTERVAL_HOURS)</span>
            )}
          </span>
        </div>
        {(b.enabled || b.lastAt !== null) && (
          <div className="kv">
            <span>Last backup</span>
            <span>
              {b.lastAt === null ? (
                'None yet'
              ) : (
                <>
                  <span title={dateTime(b.lastAt)}>{relativeTime(b.lastAt)}</span> · {bytes(b.lastBytes)}
                  {b.lastKey && <div className="mono small muted">{b.lastKey}</div>}
                </>
              )}
            </span>
          </div>
        )}
        {b.lastError && <div className="notice danger small">Last backup failed: {b.lastError}</div>}
      </div>
    </section>
  );
}

export function Jobs() {
  const [state, setState] = useState<'dead' | 'queued' | 'running' | 'done'>('dead');
  const [view, setView] = useState<'jobs' | 'audit'>('jobs');
  const qc = useQueryClient();
  const toast = useToast();
  const jobs = useQuery({ queryKey: qk.jobs(state), queryFn: () => get<JobView[]>(`/jobs?state=${state}`), enabled: view === 'jobs', refetchInterval: 10_000 });
  const audit = useQuery({ queryKey: qk.audit, queryFn: () => get<AuditEntryView[]>('/audit'), enabled: view === 'audit' });
  const retry = useMutation({
    mutationFn: (id: number) => post(`/jobs/${id}/retry`),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['jobs'] }), toast('Retrying')),
    onError: (e) => toast(errorText(e)),
  });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Jobs &amp; audit</h1>
      </div>
      <ServerCard />
      <div className="tabs">
        <button type="button" className={`tab${view === 'jobs' ? ' active' : ''}`} onClick={() => setView('jobs')}>
          Background jobs
        </button>
        <button type="button" className={`tab${view === 'audit' ? ' active' : ''}`} onClick={() => setView('audit')}>
          Audit log
        </button>
      </div>
      {view === 'jobs' ? (
        <>
          <div className="filters">
            {(['dead', 'queued', 'running', 'done'] as const).map((s) => (
              <button key={s} type="button" className={s === state ? 'small primary' : 'small'} onClick={() => setState(s)}>
                {s === 'dead' ? 'Failed' : s[0]!.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="card">
            {jobs.data?.length === 0 ? (
              <Empty title={state === 'dead' ? 'Nothing failed' : 'No jobs'} />
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Attempts</th>
                    <th>Updated</th>
                    <th>Error</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {jobs.data?.map((j) => (
                    <tr key={j.id}>
                      <td className="mono">
                        {j.kind} #{j.id}
                      </td>
                      <td>
                        {j.attempts}/{j.maxAttempts}
                      </td>
                      <td title={dateTime(j.updatedAt)}>{relativeTime(j.updatedAt)}</td>
                      <td className="small" style={{ maxWidth: 420, wordBreak: 'break-word' }}>
                        {j.lastError ?? '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {(j.state === 'dead' || j.state === 'queued') && (
                          <button type="button" className="small" onClick={() => retry.mutate(j.id)}>
                            Retry now
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <div className="card">
          <table className="list">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.map((a) => (
                <tr key={a.id}>
                  <td title={dateTime(a.createdAt)}>{relativeTime(a.createdAt)}</td>
                  <td>{a.user?.name ?? a.user?.email ?? 'CLI'}</td>
                  <td>
                    <span className="mono">{a.action}</span> <span className="muted small">{Object.keys(a.data).length ? JSON.stringify(a.data) : ''}</span>
                  </td>
                  <td className="mono small">{a.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
