import type { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '../lib/auth';
import { useProjects, useServerInfo } from '../lib/queries';
import { useSelectedProject } from '../lib/project';
import { Activity, Inbox, Logo, Plus, Settings, Users } from './icons';
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
  const [, navigate] = useLocation();
  const total = projects.data?.reduce((n, p) => n + p.openTickets, 0) ?? 0;

  return (
    <div className="shell">
      <aside className="sidebar">
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
            <Link href={`/projects/${p.id}/settings`} className="nav-link" title={`${p.name} settings`} aria-label={`${p.name} settings`}>
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
