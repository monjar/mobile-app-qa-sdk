import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH, type UserRole, type UserView } from '@snitch/contract';
import { errorText, patch, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import { qk, useUsers } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { Avatar, Dialog, useToast } from '../components/ui';

export function Team() {
  const users = useUsers();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserView | null>(null);
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
                    <div>
                      <div>{u.name ?? u.email}</div>
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
                <td>{u.lastLoginAt ? relativeTime(u.lastLoginAt) : 'Never'}</td>
                <td style={{ textAlign: 'right' }}>
                  {u.id !== me?.id && (
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button type="button" className="small" onClick={() => setResetting(u)}>
                        Reset password
                      </button>
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
      <p className="muted small">Admins manage projects, integrations and people. Members triage, comment and escalate.</p>
      {adding && <AddUser onClose={() => setAdding(false)} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post('/users', { email, name: name || undefined, role, password }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: qk.users }), onClose()),
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
            Add
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
        <label className="field">
          Temporary password
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={PASSWORD_MIN_LENGTH} autoComplete="off" />
          <span className="field-hint">Share it with them privately. At least {PASSWORD_MIN_LENGTH} characters.</span>
        </label>
        {error && <div className="error-text">{error}</div>}
      </form>
    </Dialog>
  );
}

function ResetPassword({ user, onClose }: { user: UserView; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const reset = useMutation({
    mutationFn: () => patch(`/users/${user.id}`, { password }),
    onSuccess: () => (toast('Password reset; their sessions were signed out'), onClose()),
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
      <label className="field">
        New password
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={PASSWORD_MIN_LENGTH} autoComplete="off" autoFocus />
      </label>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}
