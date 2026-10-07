/**
 * Everything about one project: install snippets, ingest keys, which builds
 * the SDK runs in (remote config), integrations and routing rules.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  CAPTURE_MODES,
  DEFAULT_SDK_CONFIG,
  PLATFORMS,
  RELEASE_TYPES,
  type CaptureMode,
  type IngestKeyCreated,
  type IngestKeyView,
  type IntegrationCreate,
  type IntegrationKind,
  type IntegrationView,
  type Platform,
  type ProjectView,
  type ReleaseType,
  type ReportTypeOption,
  type RoutingRuleView,
  type SdkConfigEntry,
  type SdkConfigView,
} from '@snitch/contract';
import { del, errorText, get, patch, post, put } from '../lib/api';
import { RELEASE_LABEL, osName, relativeTime } from '../lib/format';
import { qk, useIntegrations, useProjects, useServerInfo } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { CopyButton, Dialog, Empty, IntegrationIcon, Snippet, useToast } from '../components/ui';

const TABS = [
  ['install', 'Install'],
  ['builds', 'Builds & capture'],
  ['integrations', 'Integrations'],
  ['routing', 'Routing'],
  ['keys', 'Keys'],
  ['general', 'General'],
] as const;
type TabId = (typeof TABS)[number][0];

export function ProjectSettings({ id, tab }: { id: string; tab?: string }) {
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === id);
  const [, navigate] = useLocation();
  const active: TabId = (TABS.find(([t]) => t === tab)?.[0] ?? 'install') as TabId;
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  if (projects.isLoading) return <div className="page empty">Loading…</div>;
  if (!project) return <div className="page empty">No such project.</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project.name}</h1>
        <span className="muted small mono">
          {project.slug} · {project.ticketPrefix}-…
        </span>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" className={`tab${t === active ? ' active' : ''}`} onClick={() => navigate(`/projects/${id}/settings/${t}`)}>
            {label}
          </button>
        ))}
      </div>
      {!isAdmin && active !== 'install' && <div className="notice" style={{ marginBottom: 12 }}>Only admins can change project settings.</div>}
      {active === 'install' && <Install project={project} />}
      {active === 'builds' && <Builds project={project} readOnly={!isAdmin} />}
      {active === 'integrations' && <Integrations project={project} readOnly={!isAdmin} />}
      {active === 'routing' && <Routing project={project} readOnly={!isAdmin} />}
      {active === 'keys' && <Keys project={project} readOnly={!isAdmin} />}
      {active === 'general' && <General project={project} readOnly={!isAdmin} />}
    </div>
  );
}

function Section({ title, hint, children, actions }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <div>
          <h2>{title}</h2>
          {hint && <div className="muted small" style={{ marginTop: 2 }}>{hint}</div>}
        </div>
        {actions}
      </div>
      <div className="card-body">{children}</div>
    </section>
  );
}

// ── Install ────────────────────────────────────────────────────────────────

function Install({ project }: { project: ProjectView }) {
  const server = useServerInfo();
  const url = server.data?.publicUrl ?? window.location.origin;
  const key = 'snitch_pk_…';
  const [platform, setPlatform] = useState<'expo' | 'rn' | 'ios' | 'android'>('expo');
  const snippets: Record<typeof platform, { title: string; steps: [string, string][] }> = {
    expo: {
      title: 'Expo (SDK 52+)',
      steps: [
        ['Install', 'npx expo install react-native-snitch'],
        [
          'Add the plugin to app.json, then rebuild your dev client / release build',
          JSON.stringify(
            { expo: { plugins: [['react-native-snitch', { serverUrl: url, ingestKey: key, enabledReleaseTypes: ['debug', 'adhoc', 'testflight', 'internal'] }]] } },
            null,
            2,
          ),
        ],
      ],
    },
    rn: {
      title: 'React Native (0.76+, new architecture)',
      steps: [
        ['Install', 'npm install react-native-snitch\ncd ios && pod install'],
        ['Start it once, e.g. in index.js', `import { Snitch } from 'react-native-snitch';\n\nSnitch.start({ serverUrl: '${url}', ingestKey: '${key}' });`],
      ],
    },
    ios: {
      title: 'iOS (Swift Package Manager)',
      steps: [
        ['Add the package', 'https://github.com/monjar/mobile-app-qa-sdk  →  product "Snitch"'],
        ['Start it in your AppDelegate or App init', `import Snitch\n\nSnitch.start(serverURL: URL(string: "${url}")!, ingestKey: "${key}")`],
      ],
    },
    android: {
      title: 'Android',
      steps: [
        ['Add JitPack and the dependency', `// settings.gradle.kts\ndependencyResolutionManagement { repositories { maven("https://jitpack.io") } }\n\n// app/build.gradle.kts\ndependencies { implementation("com.github.monjar.mobile-app-qa-sdk:snitch:0.1.0") }`],
        [
          'Configure it in AndroidManifest.xml (no code needed)',
          `<application …>\n  <meta-data android:name="io.github.monjar.snitch.SERVER_URL" android:value="${url}" />\n  <meta-data android:name="io.github.monjar.snitch.INGEST_KEY" android:value="${key}" />\n</application>`,
        ],
      ],
    },
  };
  const s = snippets[platform];
  return (
    <>
      <Section title="Add Snitch to your app" hint={<>Use an ingest key from the <Link href={`/projects/${project.id}/settings/keys`}>Keys</Link> tab in place of {key}.</>}>
        <div className="row wrap" style={{ marginBottom: 12 }}>
          {(['expo', 'rn', 'ios', 'android'] as const).map((p) => (
            <button key={p} type="button" className={p === platform ? 'primary small' : 'small'} onClick={() => setPlatform(p)}>
              {snippets[p].title}
            </button>
          ))}
        </div>
        <div className="stack">
          {s.steps.map(([label, code]) => (
            <div key={label} className="stack" style={{ gap: 6 }}>
              <span className="small muted">{label}</span>
              <Snippet code={code} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="How testers use it">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Hold three fingers on the screen for a moment to open the report sheet.</li>
          <li>Taking a system screenshot offers “Report this screen?”.</li>
          <li>The last 30 seconds of screen activity stay on the device and are only sent with a report.</li>
          <li>Store builds (App Store, Google Play) are off unless you enable them under Builds &amp; capture.</li>
        </ul>
      </Section>
    </>
  );
}

// ── Builds & capture (remote SDK config) ───────────────────────────────────

type CellKey = `${Platform}/${ReleaseType}`;

function Builds({ project, readOnly }: { project: ProjectView; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({ queryKey: qk.sdkConfig(project.id), queryFn: () => get<SdkConfigView>(`/projects/${project.id}/sdk-config`) });
  const [allowed, setAllowed] = useState<ReleaseType[]>(project.allowedReleaseTypes);
  const [entries, setEntries] = useState<SdkConfigEntry[]>([]);
  useEffect(() => setAllowed(project.allowedReleaseTypes), [project.allowedReleaseTypes]);
  useEffect(() => {
    if (cfg.data) setEntries(cfg.data.entries);
  }, [cfg.data]);

  const entry = (platform: Platform | '*', releaseType: ReleaseType | '*') => entries.find((e) => e.platform === platform && e.releaseType === releaseType);
  const setEntry = (platform: Platform | '*', releaseType: ReleaseType | '*', change: (c: SdkConfigEntry['config']) => SdkConfigEntry['config']) => {
    setEntries((list) => {
      const rest = list.filter((e) => !(e.platform === platform && e.releaseType === releaseType));
      const next = change(entry(platform, releaseType)?.config ?? {});
      return Object.keys(next).length ? [...rest, { platform, releaseType, config: next }] : rest;
    });
  };
  const global = entry('*', '*')?.config ?? {};
  const effectiveMode = (k: CellKey) => cfg.data?.effective[k]?.video.captureMode ?? 'snapshot';

  const save = useMutation({
    mutationFn: async () => {
      await patch(`/projects/${project.id}`, { allowedReleaseTypes: allowed });
      return put<SdkConfigView>(`/projects/${project.id}/sdk-config`, { entries });
    },
    onSuccess: (data) => {
      qc.setQueryData(qk.sdkConfig(project.id), data);
      void qc.invalidateQueries({ queryKey: qk.projects });
      toast('Saved — devices pick it up on their next config refresh');
    },
    onError: (e) => toast(errorText(e)),
  });

  const toggleAllowed = (r: ReleaseType) => setAllowed((a) => (a.includes(r) ? a.filter((x) => x !== r) : [...a, r]));

  return (
    <>
      <Section
        title="Which builds run Snitch"
        hint="The SDK detects how the app was installed. Builds you leave unticked turn Snitch off remotely and their reports are refused."
      >
        <table className="list matrix">
          <thead>
            <tr>
              <th>Build</th>
              <th>Enabled</th>
              {PLATFORMS.map((p) => (
                <th key={p}>{osName(p)} video</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {RELEASE_TYPES.filter((r) => r !== 'unknown').map((r) => (
              <tr key={r}>
                <td>
                  {RELEASE_LABEL[r]}
                  <div className="muted small">{RELEASE_HINT[r]}</div>
                </td>
                <td>
                  <input type="checkbox" checked={allowed.includes(r)} onChange={() => toggleAllowed(r)} disabled={readOnly} aria-label={`Enable for ${RELEASE_LABEL[r]}`} />
                </td>
                {PLATFORMS.map((p) => {
                  const own = entry(p, r)?.config.video?.captureMode;
                  return (
                    <td key={p}>
                      <select
                        value={own ?? ''}
                        disabled={readOnly || !allowed.includes(r)}
                        aria-label={`${osName(p)} ${RELEASE_LABEL[r]} video`}
                        onChange={(e) => {
                          const v = e.target.value as CaptureMode | '';
                          setEntry(p, r, (c) => {
                            const video = { ...c.video };
                            if (v) video.captureMode = v;
                            else delete video.captureMode;
                            const { video: _old, ...rest } = c;
                            return Object.keys(video).length === 0 ? rest : { ...rest, video };
                          });
                        }}
                      >
                        <option value="">Default ({effectiveMode(`${p}/${r}` as CellKey)})</option>
                        {CAPTURE_MODES.map((m) => (
                          <option key={m} value={m}>
                            {MODE_LABEL[m]}
                          </option>
                        ))}
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Capture defaults" hint="Applies to every build unless overridden above.">
        <div className="form">
          <div className="form-row">
            <label className="field">
              Video
              <select
                value={global.video?.captureMode ?? DEFAULT_SDK_CONFIG.video.captureMode}
                disabled={readOnly}
                onChange={(e) => setEntry('*', '*', (c) => ({ ...c, video: { ...c.video, captureMode: e.target.value as CaptureMode } }))}
              >
                {CAPTURE_MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
              <span className="field-hint">System capture only works if the app enabled it at build time.</span>
            </label>
            <NumberField
              label="Longest clip (s)"
              min={1}
              max={30}
              step={1}
              value={global.video?.maxSeconds ?? DEFAULT_SDK_CONFIG.video.maxSeconds}
              disabled={readOnly}
              onChange={(v) => setEntry('*', '*', (c) => ({ ...c, video: { ...c.video, maxSeconds: v } }))}
            />
            <NumberField
              label="Idle frames / s"
              min={0.2}
              max={10}
              step={0.1}
              value={global.video?.idleFps ?? DEFAULT_SDK_CONFIG.video.idleFps}
              disabled={readOnly}
              onChange={(v) => setEntry('*', '*', (c) => ({ ...c, video: { ...c.video, idleFps: v } }))}
            />
            <NumberField
              label="Frames / s after a touch"
              min={0.2}
              max={15}
              step={0.5}
              value={global.video?.activeFps ?? DEFAULT_SDK_CONFIG.video.activeFps}
              disabled={readOnly}
              onChange={(v) => setEntry('*', '*', (c) => ({ ...c, video: { ...c.video, activeFps: v } }))}
            />
          </div>
          <div className="row wrap" style={{ gap: 16 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={global.maskTextInputs ?? DEFAULT_SDK_CONFIG.maskTextInputs}
                disabled={readOnly}
                onChange={(e) => setEntry('*', '*', (c) => ({ ...c, maskTextInputs: e.target.checked }))}
              />
              Hide text fields in screenshots and video
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={global.screenshotPrompt ?? DEFAULT_SDK_CONFIG.screenshotPrompt}
                disabled={readOnly}
                onChange={(e) => setEntry('*', '*', (c) => ({ ...c, screenshotPrompt: e.target.checked }))}
              />
              Offer to report after a system screenshot
            </label>
          </div>
          <label className="field">
            Message shown on the report sheet
            <input
              value={global.message ?? ''}
              maxLength={500}
              disabled={readOnly}
              placeholder="e.g. Thanks for testing build 15!"
              onChange={(e) => setEntry('*', '*', (c) => ({ ...c, message: e.target.value || null }))}
            />
          </label>
        </div>
      </Section>
      {!readOnly && (
        <div className="row">
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </button>
        </div>
      )}
    </>
  );
}

const MODE_LABEL: Record<CaptureMode, string> = { snapshot: 'In-app snapshots', system: 'System capture', off: 'Off' };
const RELEASE_HINT: Record<ReleaseType, string> = {
  debug: 'Xcode / Android Studio / simulators',
  adhoc: 'iOS ad-hoc and EAS preview builds',
  enterprise: 'iOS in-house distribution',
  testflight: 'iOS TestFlight',
  appstore: 'iOS App Store',
  internal: 'Android sideloads, Firebase, MDM',
  play: 'Google Play and other stores',
  unknown: '',
};

function NumberField({ label, value, onChange, min, max, step, disabled }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; disabled?: boolean }) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );
}

// ── Integrations ───────────────────────────────────────────────────────────

function Integrations({ project, readOnly }: { project: ProjectView; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useIntegrations(project.id);
  const server = useServerInfo();
  const [adding, setAdding] = useState<IntegrationKind | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: qk.integrations(project.id) });
  const test = useMutation({
    mutationFn: (id: string) => post<{ message: string }>(`/integrations/${id}/test`),
    onSuccess: (r) => toast(r.message),
    onError: (e) => toast(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (i: IntegrationView) => patch(`/integrations/${i.id}`, { enabled: !i.enabled }),
    onSuccess: refresh,
    onError: (e) => toast(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (i: IntegrationView) => del(`/integrations/${i.id}`),
    onSuccess: () => (refresh(), void qc.invalidateQueries({ queryKey: qk.routing(project.id) })),
    onError: (e) => toast(errorText(e)),
  });

  return (
    <>
      <Section
        title="Integrations"
        hint="Where tickets go when you escalate them. Add routing rules to send some report types automatically."
        actions={
          !readOnly && (
            <div className="row">
              <button type="button" className="small" onClick={() => setAdding('github')}>
                <IntegrationIcon kind="github" /> GitHub
              </button>
              <button type="button" className="small" onClick={() => setAdding('email')}>
                <IntegrationIcon kind="email" /> Email
              </button>
              <button type="button" className="small" onClick={() => setAdding('webhook')}>
                <IntegrationIcon kind="webhook" /> Webhook
              </button>
            </div>
          )
        }
      >
        {server.data?.mail === 'console' && <div className="notice warn" style={{ marginBottom: 12 }}>Email is not configured on this server (set SNITCH_SMTP_URL), so email integrations will fail.</div>}
        {list.data?.length === 0 ? (
          <Empty title="No integrations yet">Connect GitHub issues, an email list, or a Slack/Discord/custom webhook.</Empty>
        ) : (
          <table className="list">
            <tbody>
              {list.data?.map((i) => (
                <tr key={i.id}>
                  <td style={{ width: 28 }}>
                    <IntegrationIcon kind={i.kind} />
                  </td>
                  <td>
                    <strong>{i.name}</strong>
                    <div className="muted small">{describeIntegration(i)}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!readOnly && (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button type="button" className="small" onClick={() => test.mutate(i.id)} disabled={test.isPending}>
                          Send test
                        </button>
                        <button type="button" className="small" onClick={() => toggle.mutate(i)}>
                          {i.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button type="button" className="small ghost danger" onClick={() => confirm(`Remove ${i.name}? Its routing rules go too.`) && remove.mutate(i)}>
                          Remove
                        </button>
                      </div>
                    )}
                    {!i.enabled && <span className="pill">Disabled</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {adding && <IntegrationDialog kind={adding} projectId={project.id} onClose={() => setAdding(null)} onSaved={() => (setAdding(null), refresh())} />}
    </>
  );
}

function describeIntegration(i: IntegrationView): string {
  const c = i.config as Record<string, unknown>;
  if (i.kind === 'github') return `${String(c.owner)}/${String(c.repo)}${c.includeShareLinks ? ' · with public media links' : ''}`;
  if (i.kind === 'email') return (c.to as string[]).join(', ');
  return `${String(c.format)} · ${(() => {
    try {
      return new URL(String(c.url)).host;
    } catch {
      return String(c.url);
    }
  })()}${i.hasSecret ? ' · signed' : ''}`;
}

function IntegrationDialog({ kind, projectId, onClose, onSaved }: { kind: IntegrationKind; projectId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(kind === 'github' ? 'GitHub issues' : kind === 'email' ? 'Email' : 'Webhook');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [labels, setLabels] = useState('bug-report');
  const [token, setToken] = useState('');
  const [shareLinks, setShareLinks] = useState(false);
  const [to, setTo] = useState('');
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<'generic' | 'slack' | 'discord'>('slack');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: IntegrationCreate) => post(`/projects/${projectId}/integrations`, body),
    onSuccess: onSaved,
    onError: (e) => setError(errorText(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    if (kind === 'github')
      create.mutate({ kind, name, secret: token.trim(), config: { owner: owner.trim(), repo: repo.trim(), labels: list(labels), assignees: [], includeShareLinks: shareLinks, shareTtlDays: 30 } });
    else if (kind === 'email') create.mutate({ kind, name, config: { to: list(to), subjectPrefix: '[Snitch]' } });
    else create.mutate({ kind, name, config: { url: url.trim(), format, includeShareLinks: shareLinks, shareTtlDays: 30 }, ...(format === 'generic' && secret ? { secret } : {}) });
  };

  return (
    <Dialog
      title={kind === 'github' ? 'Connect GitHub' : kind === 'email' ? 'Email escalation' : 'Webhook'}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="integration-form" className="primary" disabled={create.isPending}>
            Save
          </button>
        </>
      }
    >
      <form id="integration-form" className="form" onSubmit={submit}>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        {kind === 'github' && (
          <>
            <div className="form-row">
              <label className="field">
                Owner
                <input value={owner} onChange={(e) => setOwner(e.target.value)} required placeholder="monjar" />
              </label>
              <label className="field">
                Repository
                <input value={repo} onChange={(e) => setRepo(e.target.value)} required placeholder="mochiro-mobile" />
              </label>
            </div>
            <label className="field">
              Access token
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="off" placeholder="github_pat_…" />
              <span className="field-hint">A fine-grained personal access token for this repository with “Issues: Read and write”. Stored encrypted.</span>
            </label>
            <label className="field">
              Labels
              <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug-report, qa" />
              <span className="field-hint">Comma-separated. A type:… label is added automatically.</span>
            </label>
          </>
        )}
        {kind === 'email' && (
          <label className="field">
            Send to
            <input value={to} onChange={(e) => setTo(e.target.value)} required placeholder="qa@example.com, dev@example.com" />
            <span className="field-hint">The screenshot is attached inline; the video is linked.</span>
          </label>
        )}
        {kind === 'webhook' && (
          <>
            <label className="field">
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
                <option value="slack">Slack incoming webhook</option>
                <option value="discord">Discord webhook</option>
                <option value="generic">Generic JSON (signed)</option>
              </select>
            </label>
            <label className="field">
              URL
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://hooks.slack.com/services/…" />
            </label>
            {format === 'generic' && (
              <label className="field">
                Signing secret (optional)
                <input value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
                <span className="field-hint">Requests carry X-Snitch-Signature: sha256=HMAC(secret, timestamp + "." + body).</span>
              </label>
            )}
          </>
        )}
        {kind !== 'email' && (
          <label className="check">
            <input type="checkbox" checked={shareLinks} onChange={(e) => setShareLinks(e.target.checked)} />
            Include public links to the screenshot and video (expire after 30 days)
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

// ── Routing ────────────────────────────────────────────────────────────────

function Routing({ project, readOnly }: { project: ProjectView; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const integrations = useIntegrations(project.id);
  const rules = useQuery({ queryKey: qk.routing(project.id), queryFn: () => get<{ rules: RoutingRuleView[] }>(`/projects/${project.id}/routing`) });
  const [draft, setDraft] = useState<RoutingRuleView[]>([]);
  useEffect(() => {
    if (rules.data) setDraft(rules.data.rules);
  }, [rules.data]);
  const save = useMutation({
    mutationFn: () => put<{ rules: RoutingRuleView[] }>(`/projects/${project.id}/routing`, { rules: draft.map(({ reportType, integrationId, mode, enabled }) => ({ reportType, integrationId, mode, enabled })) }),
    onSuccess: (d) => (qc.setQueryData(qk.routing(project.id), d), toast('Routing saved')),
    onError: (e) => toast(errorText(e)),
  });
  const types: ReportTypeOption[] = [{ id: '*', label: 'Any type' }, ...project.reportTypes];
  const first = integrations.data?.[0];

  return (
    <Section title="Routing" hint="Per report type: send automatically when a report arrives, or just suggest the destination on the ticket.">
      {!integrations.data?.length ? (
        <Empty title="Add an integration first">
          <Link href={`/projects/${project.id}/settings/integrations`}>Go to Integrations</Link>
        </Empty>
      ) : (
        <div className="stack">
          <table className="list">
            <thead>
              <tr>
                <th>When a report is</th>
                <th>Send to</th>
                <th>How</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {draft.map((r, idx) => (
                <tr key={r.id || idx}>
                  <td>
                    <select value={r.reportType} disabled={readOnly} onChange={(e) => setDraft((d) => d.map((x, i) => (i === idx ? { ...x, reportType: e.target.value } : x)))}>
                      {types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={r.integrationId} disabled={readOnly} onChange={(e) => setDraft((d) => d.map((x, i) => (i === idx ? { ...x, integrationId: e.target.value } : x)))}>
                      {integrations.data.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select value={r.mode} disabled={readOnly} onChange={(e) => setDraft((d) => d.map((x, i) => (i === idx ? { ...x, mode: e.target.value as 'auto' | 'suggest' } : x)))}>
                      <option value="auto">Send automatically</option>
                      <option value="suggest">Suggest on the ticket</option>
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!readOnly && (
                      <button type="button" className="small ghost danger" onClick={() => setDraft((d) => d.filter((_, i) => i !== idx))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <div className="row">
              <button
                type="button"
                className="small"
                onClick={() => first && setDraft((d) => [...d, { id: '', position: d.length, reportType: project.reportTypes[0]?.id ?? '*', integrationId: first.id, mode: 'suggest', enabled: true }])}
              >
                Add rule
              </button>
              <span className="spacer" />
              <button type="button" className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ── Keys ───────────────────────────────────────────────────────────────────

function Keys({ project, readOnly }: { project: ProjectView; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useQuery({ queryKey: qk.keys(project.id), queryFn: () => get<IngestKeyView[]>(`/projects/${project.id}/keys`) });
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<IngestKeyCreated>(`/projects/${project.id}/keys`, { label: `Key ${new Date().toLocaleDateString()}` }),
    onSuccess: (r) => (setCreated(r.plaintext), void qc.invalidateQueries({ queryKey: qk.keys(project.id) })),
    onError: (e) => toast(errorText(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/keys/${id}`),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: qk.keys(project.id) }), toast('Key revoked')),
  });
  return (
    <Section
      title="Ingest keys"
      hint="Apps use a key to send reports to this project. Keys ship inside your app, so they only allow sending reports — rotate one if it leaks."
      actions={
        !readOnly && (
          <button type="button" className="small primary" onClick={() => create.mutate()} disabled={create.isPending}>
            New key
          </button>
        )
      }
    >
      <table className="list">
        <thead>
          <tr>
            <th>Key</th>
            <th>Label</th>
            <th>Created</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.data?.map((k) => (
            <tr key={k.id} style={k.revokedAt ? { opacity: 0.5 } : undefined}>
              <td className="mono">{k.prefix}…</td>
              <td>{k.label ?? '—'}</td>
              <td>{relativeTime(k.createdAt)}</td>
              <td>{k.lastUsedAt ? relativeTime(k.lastUsedAt) : 'Never'}</td>
              <td style={{ textAlign: 'right' }}>
                {k.revokedAt ? (
                  <span className="pill">Revoked</span>
                ) : (
                  !readOnly && (
                    <button type="button" className="small ghost danger" onClick={() => confirm('Revoke this key? Apps using it stop sending reports.') && revoke.mutate(k.id)}>
                      Revoke
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {created && (
        <Dialog title="New ingest key" onClose={() => setCreated(null)} footer={<button type="button" className="primary" onClick={() => setCreated(null)}>Done</button>}>
          <div className="stack">
            <div className="secret-box">{created}</div>
            <span className="muted small">Copy it now — it won't be shown again.</span>
            <CopyButton text={created} label="Copy key" />
          </div>
        </Dialog>
      )}
    </Section>
  );
}

// ── General ────────────────────────────────────────────────────────────────

function General({ project, readOnly }: { project: ProjectView; readOnly: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [types, setTypes] = useState<ReportTypeOption[]>(project.reportTypes);
  const [appIds, setAppIds] = useState((project.allowedAppIds ?? []).join(', '));
  const [retention, setRetention] = useState(project.retentionDays === null ? '' : String(project.retentionDays));
  const dirty = useMemo(
    () => name !== project.name || JSON.stringify(types) !== JSON.stringify(project.reportTypes) || appIds !== (project.allowedAppIds ?? []).join(', ') || retention !== (project.retentionDays === null ? '' : String(project.retentionDays)),
    [name, types, appIds, retention, project],
  );
  const save = useMutation({
    mutationFn: () => {
      const ids = appIds.split(',').map((s) => s.trim()).filter(Boolean);
      return patch(`/projects/${project.id}`, {
        name,
        reportTypes: types.map((t) => ({ id: t.id.trim(), label: t.label.trim() })),
        allowedAppIds: ids.length ? ids : null,
        retentionDays: retention.trim() === '' ? null : Number(retention),
      });
    },
    onSuccess: () => (void qc.invalidateQueries({ queryKey: qk.projects }), toast('Saved')),
    onError: (e) => toast(errorText(e)),
  });
  return (
    <>
      <Section title="Project">
        <div className="form">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} maxLength={80} />
          </label>
          <label className="field">
            Accepted app ids
            <input value={appIds} onChange={(e) => setAppIds(e.target.value)} disabled={readOnly} placeholder="Any (e.g. com.mochiro.app)" />
            <span className="field-hint">Reports from other bundle ids / application ids are refused. Leave empty to accept any.</span>
          </label>
          <label className="field">
            Keep tickets for (days)
            <input type="number" min={1} max={3650} value={retention} onChange={(e) => setRetention(e.target.value)} disabled={readOnly} placeholder="Server default" />
            <span className="field-hint">Older tickets are deleted with their screenshots and videos.</span>
          </label>
        </div>
      </Section>
      <Section title="Report types" hint="What testers pick on the report sheet. Routing rules match on these ids.">
        <div className="stack">
          {types.map((t, i) => (
            <div key={i} className="row">
              <input aria-label="Label" value={t.label} onChange={(e) => setTypes((ts) => ts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} disabled={readOnly} maxLength={40} />
              <input
                aria-label="Id"
                className="mono"
                value={t.id}
                onChange={(e) => setTypes((ts) => ts.map((x, j) => (j === i ? { ...x, id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') } : x)))}
                disabled={readOnly}
                maxLength={24}
                style={{ width: 140 }}
              />
              {!readOnly && types.length > 1 && (
                <button type="button" className="small ghost danger" onClick={() => setTypes((ts) => ts.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {!readOnly && types.length < 8 && (
            <div>
              <button type="button" className="small" onClick={() => setTypes((ts) => [...ts, { id: `type${ts.length + 1}`, label: 'New type' }])}>
                Add type
              </button>
            </div>
          )}
        </div>
      </Section>
      {!readOnly && (
        <div className="row">
          <span className="spacer" />
          <button type="button" className="primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            Save
          </button>
        </div>
      )}
    </>
  );
}
