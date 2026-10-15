import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '../lib/auth';
import { useProjects, useServerInfo } from '../lib/queries';
import { useSelectedProject } from '../lib/project';
import { Activity, Inbox, Logo, Menu, Phone, Plus, Settings, Users } from './icons';
import { Avatar } from './ui';

function NavLink({ href, children, count, match }: { href: string; children: ReactNode; count?: number; match?: (path: string) => boolean }) {
  const [path] = useLocation();
  const active = match ? match(path) : path === href;
  return (
    <Link href={href} className={`nav-link${active ? ' active' : ''}`}>
      <span className="row">{children}</span>
      {count !== undefined && count > 0 && <span className="nav-count">{count}</span>}
    </Link>
  );
}

export function Layout({ children, onNewProject }: { children: ReactNode; onNewProject: () => void }) {
  const { user, signOut } = useAuth();
  const projects = useProjects();
  const server = useServerInfo();
  const [selected, setSelected] = useSelectedProject();
  const [path, navigate] = useLocation();
  const total = projects.data?.reduce((n, p) => n + p.openTickets, 0) ?? 0;
  // Below 960px the sidebar is a drawer behind the top bar's menu button.
  const [navOpen, setNavOpen] = useState(false);
  const narrow = useNarrow();
  useEffect(() => setNavOpen(false), [path, selected]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  const current = selected === 'all' ? 'All projects' : (projects.data?.find((p) => p.id === selected)?.name ?? 'Snitch');

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <header className="topbar">
        <button type="button" className="ghost icon-button" aria-label="Menu" aria-expanded={navOpen} onClick={() => setNavOpen((o) => !o)}>
          <Menu />
        </button>
        <Link href="/" className="brand">
          <Logo /> Snitch
        </Link>
        <span className="topbar-context">{current}</span>
      </header>
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      {/* A closed drawer is off screen: keep focus and screen readers out of it. */}
      <aside className="sidebar" aria-label="Navigation" inert={narrow && !navOpen ? true : undefined}>
        <div className="brand">
          <Logo /> Snitch
        </div>
        <NavLink
          href="/"
          count={selected === 'all' ? total : projects.data?.find((p) => p.id === selected)?.openTickets}
          match={(p) => p === '/' || p.startsWith('/tickets')}
        >
          <Inbox /> Inbox
        </NavLink>

        <div className="nav-section">Projects</div>
        <button type="button" className={`nav-link ghost${selected === 'all' ? ' active' : ''}`} style={{ height: 'auto' }} onClick={() => (setSelected('all'), navigate('/'))}>
          <span>All projects</span>
          <span className="nav-count">{total || ''}</span>
        </button>
        {projects.data?.map((p) => (
          <div key={p.id} className="row" style={{ gap: 0 }}>
            <button
              type="button"
              className={`nav-link ghost${selected === p.id ? ' active' : ''}`}
              style={{ height: 'auto', flex: 1 }}
              onClick={() => (setSelected(p.id), navigate('/'))}
            >
              <span>{p.name}</span>
              <span className="nav-count">{p.openTickets || ''}</span>
            </button>
            <Link
              href={`/projects/${p.id}/devices`}
              className={`nav-link${path === `/projects/${p.id}/devices` ? ' active' : ''}`}
              title={`${p.name} devices`}
              aria-label={`${p.name} devices`}
            >
              <Phone />
            </Link>
            <Link
              href={`/projects/${p.id}/settings`}
              className={`nav-link${path.startsWith(`/projects/${p.id}/settings`) ? ' active' : ''}`}
              title={`${p.name} settings`}
              aria-label={`${p.name} settings`}
            >
              <Settings />
            </Link>
          </div>
        ))}
        {user?.role === 'admin' && (
          <button type="button" className="ghost small" style={{ justifyContent: 'flex-start' }} onClick={onNewProject}>
            <Plus /> New project
          </button>
        )}

        {user?.role === 'admin' && (
          <>
            <div className="nav-section">Admin</div>
            <NavLink href="/team">
              <Users /> Team
            </NavLink>
            <NavLink href="/jobs">
              <Activity /> Jobs &amp; audit
            </NavLink>
          </>
        )}

        <div className="sidebar-footer">
          <span className="row" title={user?.email}>
            {user && <Avatar name={user.name ?? user.email} />}
            <span className="small">{server.data ? `v${server.data.version}` : ''}</span>
          </span>
          <button type="button" className="ghost small" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

/** True below the width where the sidebar turns into a drawer (styles.css). */
function useNarrow(): boolean {
  const query = '(max-width: 960px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
