import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { Me } from '@snitch/contract';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Logo } from '../components/icons';

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);

  useEffect(() => {
    api<{ needed: boolean }>('/auth/setup')
      .then((r) => setSetupNeeded(r.needed))
      .catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signIn(await api<Me>('/auth/login', { method: 'POST', body: { email, password } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="card">
        <form className="card-body form" onSubmit={submit}>
          <div className="brand">
            <Logo /> Snitch
          </div>
          {setupNeeded && <div className="notice warn">No accounts yet. Open the setup link printed in the server log to create the first admin.</div>}
          <label className="field">
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label className="field">
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          {error && <div className="error-text">{error}</div>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function Setup() {
  const { signIn } = useAuth();
  const search = useSearch();
  const [, navigate] = useLocation();
  const token = new URLSearchParams(search).get('token') ?? '';
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signIn(await api<Me>('/auth/setup', { method: 'POST', body: { token, email, name: name || undefined, password } }));
      navigate('/');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="card">
        <form className="card-body form" onSubmit={submit}>
          <div className="brand">
            <Logo /> Welcome to Snitch
          </div>
          <p className="muted small" style={{ margin: 0 }}>
            Create the first admin account. You can invite the rest of your team afterwards.
          </p>
          {!token && <div className="notice warn">This page needs the setup link from the server log (it ends in ?token=…).</div>}
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label className="field">
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
            <span className="field-hint">At least 10 characters.</span>
          </label>
          {error && <div className="error-text">{error}</div>}
          <button className="primary" type="submit" disabled={busy || !token}>
            Create admin
          </button>
        </form>
      </div>
    </div>
  );
}
