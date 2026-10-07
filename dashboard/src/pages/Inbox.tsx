/**
 * The triage queue: tickets by status, newest first, filterable, with j/k/Enter
 * keyboard navigation. Polls so new reports appear without a reload.
 */
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import { PLATFORMS, RELEASE_TYPES, TICKET_STATUSES, type TicketList, type TicketStatus, type TicketSummary } from '@snitch/contract';
import { get } from '../lib/api';
import { RELEASE_LABEL, STATUS_LABEL, osName, relativeTime } from '../lib/format';
import { useSelectedProject } from '../lib/project';
import { useProjects } from '../lib/queries';
import { Film, Image, Search } from '../components/icons';
import { Avatar, Empty, IntegrationIcon, StatusPill } from '../components/ui';

type Tab = 'open' | TicketStatus | 'all';
const TABS: Tab[] = ['open', ...TICKET_STATUSES, 'all'];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Inbox() {
  const [projectId] = useSelectedProject();
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === projectId);
  const [tab, setTab] = useState<Tab>('open');
  const [type, setType] = useState('');
  const [platform, setPlatform] = useState('');
  const [releaseType, setReleaseType] = useState('');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 250);
  const [selected, setSelected] = useState(0);
  const [, navigate] = useLocation();

  const params = useMemo(() => {
    const p = new URLSearchParams({ status: tab, limit: '50' });
    if (projectId !== 'all') p.set('projectId', projectId);
    if (type) p.set('type', type);
    if (platform) p.set('platform', platform);
    if (releaseType) p.set('releaseType', releaseType);
    if (query) p.set('q', query);
    return p.toString();
  }, [tab, projectId, type, platform, releaseType, query]);

  const tickets = useInfiniteQuery({
    queryKey: ['tickets', params],
    queryFn: ({ pageParam }) => get<TicketList>(`/tickets?${params}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const items: TicketSummary[] = tickets.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = tickets.data?.pages[0]?.counts;
  const openCount = counts ? counts.new + counts.triaged + counts.in_progress : undefined;
  const allCount = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : undefined;

  const reportTypes = useMemo(() => {
    const list = project ? project.reportTypes : (projects.data ?? []).flatMap((p) => p.reportTypes);
    return [...new Map(list.map((r) => [r.id, r])).values()];
  }, [project, projects.data]);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name;

  useEffect(() => setSelected(0), [params]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'j') setSelected((s) => Math.min(s + 1, items.length - 1));
      else if (e.key === 'k') setSelected((s) => Math.max(s - 1, 0));
      else if (e.key === 'Enter' && items[selected]) navigate(`/tickets/${items[selected].id}`);
      else if (e.key === '/') {
        e.preventDefault();
        document.getElementById('inbox-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selected, navigate]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>{project ? project.name : 'All projects'}</h1>
        <span className="muted small">
          <span className="kbd">j</span> <span className="kbd">k</span> to move, <span className="kbd">↵</span> to open, <span className="kbd">/</span> to search
        </span>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'open' ? 'Open' : t === 'all' ? 'All' : STATUS_LABEL[t]}
            <span className="count">{t === 'open' ? openCount : t === 'all' ? allCount : counts?.[t]}</span>
          </button>
        ))}
      </div>

      <div className="filters">
        <div className="row" style={{ flex: 1, minWidth: 220, position: 'relative' }}>
          <Search className="icon-inline" style={{ position: 'absolute', left: 9, color: 'var(--text-3)' }} />
          <input id="inbox-search" placeholder="Search title, description, reporter, device or MOCH-42" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, paddingLeft: 30 }} />
        </div>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {reportTypes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
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
      </div>

      <div className="card">
        {tickets.isLoading ? (
          <div className="empty">Loading…</div>
        ) : tickets.isError ? (
          <div className="empty error-text">Couldn't load tickets.</div>
        ) : items.length === 0 ? (
          <Empty title={query ? 'Nothing matches' : tab === 'open' ? 'Inbox zero' : 'No tickets here'}>
            {!query && projects.data?.length === 0 ? 'Create a project, add the SDK to your app, and reports will land here.' : null}
          </Empty>
        ) : (
          <ul className="ticket-list">
            {items.map((t, i) => (
              <li key={t.id}>
                <Link href={`/tickets/${t.id}`} className={`ticket-row${i === selected ? ' selected' : ''}`} onMouseEnter={() => setSelected(i)}>
                  <span className="ticket-key">{t.key}</span>
                  <span style={{ minWidth: 0 }}>
                    <div className="ticket-title">{t.title}</div>
                    <div className="ticket-meta">
                      <StatusPill status={t.status} />
                      <span className="pill">{reportTypes.find((r) => r.id === t.type)?.label ?? t.type}</span>
                      <span>
                        {t.deviceModel} · {osName(t.platform)} {t.osVersion}
                      </span>
                      <span>
                        v{t.appVersion} ({t.appBuild}) · {RELEASE_LABEL[t.releaseType]}
                      </span>
                      {projectId === 'all' && <span>{projectName(t.projectId)}</span>}
                      {t.uploadState !== 'complete' && <span className="pill">{t.uploadState === 'pending' ? 'Uploading…' : 'Incomplete'}</span>}
                    </div>
                  </span>
                  <span className="ticket-side">
                    {t.escalations.map((e) => (
                      <span key={e.integrationId} className={`pill ${e.state}`} title={`${e.name}: ${e.state}`}>
                        <IntegrationIcon kind={e.kind} />
                      </span>
                    ))}
                    {t.hasScreenshot && <Image className="icon-inline" aria-label="Screenshot" />}
                    {t.videoSeconds !== null && (
                      <span className="row" style={{ gap: 2 }}>
                        <Film className="icon-inline" aria-label="Video" />
                        {Math.round(t.videoSeconds)}s
                      </span>
                    )}
                    {t.assignee && <Avatar name={t.assignee.name ?? t.assignee.email} />}
                    <span title={new Date(t.createdAt).toLocaleString()}>{relativeTime(t.createdAt)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {tickets.hasNextPage && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
          <button type="button" onClick={() => void tickets.fetchNextPage()} disabled={tickets.isFetchingNextPage}>
            {tickets.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
