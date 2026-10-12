/**
 * Installs that checked in: every config fetch from SDK 0.3+ carries an install
 * id, so this shows which builds are out there, how each install's release type
 * was detected (and from which signals), and whether Snitch is running on it.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { PLATFORMS, RELEASE_TYPES, type DeviceList, type DeviceView, type ReleaseType } from '@snitch/contract';
import { errorText, get } from '../lib/api';
import { RELEASE_LABEL, dateTime, osName, relativeTime } from '../lib/format';
import { qk, useProjects } from '../lib/queries';
import { deviceVector, parseSignals, type DeviceVector } from '../lib/signals';
import { Copy } from '../components/icons';
import { Dialog, Empty, Snippet, useToast } from '../components/ui';

const SINCE_DAYS = [7, 30, 90] as const;

export function Devices({ id }: { id: string }) {
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === id);
  const [platform, setPlatform] = useState('');
  const [releaseType, setReleaseType] = useState('');
  const [sinceDays, setSinceDays] = useState<number>(30);
  const [vector, setVector] = useState<DeviceVector | null>(null);
  const toast = useToast();

  const params = useMemo(() => {
    const p = new URLSearchParams({ sinceDays: String(sinceDays), limit: '500' });
    if (platform) p.set('platform', platform);
    if (releaseType) p.set('releaseType', releaseType);
    return p.toString();
  }, [platform, releaseType, sinceDays]);
  const devices = useQuery({ queryKey: qk.devices(id, params), queryFn: () => get<DeviceList>(`/projects/${id}/devices?${params}`), refetchInterval: 30_000 });
  const filtered = platform !== '' || releaseType !== '';

  const copyVector = (v: DeviceVector) => {
    setVector(v);
    // Without clipboard access (plain http) the dialog still shows it to copy by hand.
    void navigator.clipboard?.writeText(vectorJson(v)).then(
      () => toast('Copied test vector'),
      () => undefined,
    );
  };

  if (projects.isLoading) return <div className="page empty">Loading…</div>;
  if (!project) return <div className="page empty">No such project.</div>;
  const data = devices.data;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project.name} devices</h1>
        <Link href={`/projects/${id}/settings`} className="btn small">
          Settings
        </Link>
      </div>

      <div className="filters">
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {osName(p)}
            </option>
          ))}
        </select>
        <select value={releaseType} onChange={(e) => setReleaseType(e.target.value)} aria-label="Release type">
          <option value="">All builds</option>
          {RELEASE_TYPES.map((r) => (
            <option key={r} value={r}>
              {RELEASE_LABEL[r]}
            </option>
          ))}
        </select>
        <select value={sinceDays} onChange={(e) => setSinceDays(Number(e.target.value))} aria-label="Seen in">
          {SINCE_DAYS.map((d) => (
            <option key={d} value={d}>
              Seen in the last {d} days
            </option>
          ))}
        </select>
      </div>

      {devices.isLoading ? (
        <div className="card empty">Loading…</div>
      ) : devices.isError || !data ? (
        <div className="card empty error-text">Couldn't load devices: {errorText(devices.error)}</div>
      ) : data.items.length === 0 ? (
        <div className="card">
          {filtered ? (
            <Empty title="No installs match">Try another platform or build, or a longer period.</Empty>
          ) : (
            <Empty title={`No devices in the last ${sinceDays} days`}>
              Devices appear here when an app with Snitch SDK 0.3 or later fetches its config, at launch and every few minutes while it runs.
            </Empty>
          )}
        </div>
      ) : (
        <div className="stack">
          <section className="card">
            <div className="card-header">
              <h2>Builds</h2>
              <span className="muted small">Installs seen per app build</span>
            </div>
            <div className="table-scroll">
              <table className="list">
                <thead>
                  <tr>
                    <th>Build</th>
                    <th>Installs</th>
                    <th>Detected as</th>
                    <th>Inactive</th>
                    <th>Reports</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {data.builds.map((b) => (
                    <tr key={`${b.platform}/${b.appVersion}/${b.build}`}>
                      <td>
                        <strong>
                          {b.appVersion} ({b.build})
                        </strong>{' '}
                        <span className="muted">{osName(b.platform)}</span>
                      </td>
                      <td>{b.installs}</td>
                      <td>
                        <span className="row wrap" style={{ gap: 4 }}>
                          {(Object.entries(b.releaseTypes) as [ReleaseType, number][]).map(([r, n]) => (
                            <ReleaseBadge key={r} type={r} count={n} />
                          ))}
                        </span>
                      </td>
                      <td>{b.inactive ? <span className="warn-text">{b.inactive}</span> : <span className="muted">0</span>}</td>
                      <td>{b.reports}</td>
                      <td title={dateTime(b.lastSeenAt)}>{relativeTime(b.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-header">
              <h2>Installs</h2>
              <span className="muted small">{data.items.length === 500 ? 'The 500 most recently seen' : `${data.items.length} ${data.items.length === 1 ? 'install' : 'installs'}`}</span>
            </div>
            <div className="table-scroll">
              <table className="list devices">
                <thead>
                  <tr>
                    <th>Last seen</th>
                    <th>Device</th>
                    <th>Build</th>
                    <th>SDK</th>
                    <th>Status</th>
                    <th>Reports</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((d) => (
                    <DeviceRow key={d.installId} d={d} onVector={copyVector} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {vector && (
        <Dialog
          title="Release-type test vector"
          onClose={() => setVector(null)}
          footer={
            <button type="button" className="primary" onClick={() => setVector(null)}>
              Done
            </button>
          }
        >
          <div className="stack">
            <span>
              Add this case to the <code>{vector.platform}</code> list in <code>contract/vectors/release-type.json</code>.
            </span>
            <Snippet code={vectorJson(vector)} />
            <div className="notice warn small">
              <code>expect</code> is what the SDK detected ({RELEASE_LABEL[vector.vector.expect]}). If that was wrong, change it to the right release type: the vector then fails until the
              classifier is fixed.
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Indented like release-type.json, so it pastes in cleanly. */
const vectorJson = (v: DeviceVector) => JSON.stringify(v.vector, null, 1);

function ReleaseBadge({ type, count }: { type: ReleaseType; count?: number }) {
  return (
    <span className={`pill release ${type}`}>
      {RELEASE_LABEL[type]}
      {count !== undefined && <span className="count">{count}</span>}
    </span>
  );
}

function DeviceRow({ d, onVector }: { d: DeviceView; onVector: (v: DeviceVector) => void }) {
  const signals = parseSignals(d.signals);
  const vector = deviceVector(d);
  return (
    <tr className={d.active ? undefined : 'inactive'}>
      <td title={`${dateTime(d.lastSeenAt)} · first seen ${dateTime(d.firstSeenAt)} · ${d.checkins} check-ins`}>{relativeTime(d.lastSeenAt)}</td>
      <td>
        <div>
          <strong>{d.model ?? 'Unknown device'}</strong> <span className="muted">{[osName(d.platform), d.os].filter(Boolean).join(' ')}</span>
        </div>
        {signals.length > 0 && (
          <div className="chips" aria-label="Release-type signals" title={d.signals ?? undefined}>
            {signals.map(([k, v], i) => (
              <span key={i} className="chip">
                <span className="muted">{k}=</span>
                {v}
              </span>
            ))}
          </div>
        )}
      </td>
      <td>
        <ReleaseBadge type={d.releaseType} />
        <div className="small muted">{d.appVersion ? `${d.appVersion} (${d.build ?? '?'})` : '—'}</div>
      </td>
      <td className="small">
        {d.sdkVersion ?? '—'}
        {d.wrapper && <div className="muted">{d.wrapper}</div>}
      </td>
      <td>
        <span className="row wrap" style={{ gap: 4 }}>
          {d.active ? (
            <span className="pill sent">Active</span>
          ) : (
            <span className="pill" title="The SDK couldn't decide the release type and stayed off; this was its one diagnostic ping">
              Inactive
            </span>
          )}
          {!d.configEnabled && (
            <span className="pill" title="The config this install last received had Snitch switched off">
              Config off
            </span>
          )}
          {d.health === 'crashloop' && (
            <span className="pill warn" title="The SDK suspected its capture crashed the app, so video is off on this install">
              Crash loop
            </span>
          )}
        </span>
      </td>
      <td>{d.reports}</td>
      <td style={{ textAlign: 'right' }}>
        <button
          type="button"
          className="small ghost"
          disabled={!vector}
          onClick={() => vector && onVector(vector)}
          title={vector ? 'Copy these signals as a case for contract/vectors/release-type.json' : 'This install sent no signals in the expected format'}
        >
          <Copy /> Copy as test vector
        </button>
      </td>
    </tr>
  );
}
