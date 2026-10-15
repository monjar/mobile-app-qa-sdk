import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type AccountLink, type UserCreated, type UserRole, type UserView } from '@snitch/contract';
import { errorText, patch, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import { qk, useUsers } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { Avatar, CopyButton, Dialog, useToast } from '../components/ui';

export function Team() {
  const users = useUsers();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserView | null>(null);
  const [link, setLink] = useState<{ user: string; purpose: 'invite' | 'reset'; link: AccountLink } | null>(null);
  const resend = useMutation({
    mutationFn: (u: UserView) => post<AccountLink>(`/users/${u.id}/invite`),
    onSuccess: (l, u) => setLink({ user: u.email, purpose: 'invite', link: l }),
    onError: (e) => toast(errorText(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patch(`/users/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.users }),
    onError: (e) => toast(errorText(e)),
  });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Team</h1>
        <button type="button" className="primary" onClick={() => setAdding(true)}>
          Add person
        </button>
      </div>
      <div className="card">
        <div className="table-scroll">
        <table className="list">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} style={u.disabled ? { opacity: 0.55 } : undefined}>
                <td>
                  <div className="row">
                    <Avatar name={u.name ?? u.email} />
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        {u.name ?? u.email}
                        {u.pending && <span className="pill warn">Invited</span>}
                      </div>
                      {u.name && <div className="muted small">{u.email}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  <select value={u.role} disabled={u.id === me?.id} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value as UserRole } })} aria-label="Role">
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </select>
                </td>
                <td>{u.pending ? 'Not yet' : u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  {u.id !== me?.id && (
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {u.pending ? (
                        <button type="button" className="small" disabled={u.disabled || resend.isPending} onClick={() => resend.mutate(u)}>
                          Resend invite
                        </button>
                      ) : (
                        <button type="button" className="small" onClick={() => setResetting(u)}>
                          Reset password
                        </button>
                      )}
                      <button type="button" className="small ghost" onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabled } })}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
      <p className="muted small">Admins manage projects, integrations and people. Members triage, comment and escalate.</p>
      {adding && <AddUser onClose={() => setAdding(false)} onInvited={(email, l) => setLink({ user: email, purpose: 'invite', link: l })} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} onLink={(l) => setLink({ user: resetting.email, purpose: 'reset', link: l })} />}
      {link && <LinkResult {...link} onClose={() => setLink(null)} />}
    </div>
  );
}

function AddUser({ onClose, onInvited }: { onClose: () => void; onInvited: (email: string, link: AccountLink) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [invite, setInvite] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<UserCreated>('/users', { email, name: name || undefined, role, ...(invite ? {} : { password }) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.users });
      onClose();
      if (r.invite) onInvited(r.user.email, r.invite);
    },
    onError: (e) => setError(errorText(e)),
  });
  const submit = (e: FormEvent) => (e.preventDefault(), create.mutate());
  return (
    <Dialog
      title="Add a person"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-user" className="primary" disabled={create.isPending}>
            {invite ? 'Send invite' : 'Add'}
          </button>
        </>
      }
    >
      <form id="add-user" className="form" onSubmit={submit}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </label>
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="check block">
          <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
          <span>
            Email them an invite
            <span className="field-hint">They choose their own password from a link that works for 7 days.</span>
          </span>
        </label>
        {!invite && (
          <label className="field">
            Temporary password
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={PASSWORD_MIN_LENGTH} autoComplete="off" />
            <span className="field-hint">Share it with them privately. At least {PASSWORD_MIN_LENGTH} characters.</span>
          </label>
        )}
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function ResetPassword({ user, onClose, onLink }: { user: UserView; onClose: () => void; onLink: (link: AccountLink) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const reset = useMutation({
    mutationFn: () => patch(`/users/${user.id}`, { password }),
    onSuccess: () => (toast('Password reset; their sessions were signed out'), onClose()),
    onError: (e) => setError(errorText(e)),
  });
  const sendLink = useMutation({
    mutationFn: () => post<AccountLink>(`/users/${user.id}/reset-link`),
    onSuccess: (l) => (onClose(), onLink(l)),
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Dialog
      title={`Reset password for ${user.name ?? user.email}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => reset.mutate()} disabled={password.length < PASSWORD_MIN_LENGTH || reset.isPending}>
            Reset
          </button>
        </>
      }
    >
      <div className="form">
        <div className="row wrap" style={{ justifyContent: 'space-between' }}>
          <span className="small muted">Let them choose a new one: a link that works for 24 hours.</span>
          <button type="button" className="small" onClick={() => sendLink.mutate()} disabled={sendLink.isPending}>
            Email a reset link
          </button>
        </div>
        <div className="divider">or set one for them</div>
        <label className="field">
          New password
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={PASSWORD_MIN_LENGTH} autoComplete="off" />
        </label>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Dialog>
  );
}

/** After an invite or reset link: whether it was emailed, and the link to pass on when it wasn't. */
function LinkResult({ user, purpose, link, onClose }: { user: string; purpose: 'invite' | 'reset'; link: AccountLink; onClose: () => void }) {
  const what = purpose === 'invite' ? 'invite' : 'reset link';
  return (
    <Dialog
      title={link.emailed ? `${purpose === 'invite' ? 'Invite' : 'Reset link'} sent` : `Send ${user} this link`}
      onClose={onClose}
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="form">
        {link.emailed ? (
          <div className="notice ok">
            We emailed the {what} to <strong>{user}</strong>. It works once, until {new Date(link.expiresAt).toLocaleString()}.
          </div>
        ) : (
          <div className="notice warn">{link.error ?? "The email didn't go out."} Send them this link yourself; it works once, until {new Date(link.expiresAt).toLocaleString()}.</div>
        )}
        <div className="secret-box">{link.url}</div>
        <div>
          <CopyButton text={link.url} label="Copy link" />
        </div>
      </div>
    </Dialog>
  );
}
