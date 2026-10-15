import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from 'wouter';
import { USER_CODE, type DeviceCodeInfo } from '@snitch/contract';
import { errorText, get, post } from '../lib/api';
import { dateTime } from '../lib/format';
import { Terminal } from '../components/icons';
import { SCOPE_LABEL } from './Tokens';

/**
 * Where `snitch login` sends people: confirm the code the terminal shows, see
 * what's asking, approve or deny. Approving makes an API token that only the
 * terminal that started the sign-in can collect.
 */
export function Device() {
  const initial = new URLSearchParams(useSearch()).get('code') ?? '';
  const [typed, setTyped] = useState(initial);
  const [code, setCode] = useState(USER_CODE.test(initial) ? initial : '');
  // A link someone sends you is how device sign-in gets phished (RFC 8628 §5.4), so approving takes a deliberate tick.
  const [confirmed, setConfirmed] = useState(false);
  const info = useQuery({ queryKey: ['device', code], queryFn: () => get<DeviceCodeInfo>(`/device/${encodeURIComponent(code)}`), enabled: code !== '', retry: false });
  const decide = useMutation({ mutationFn: (d: 'approve' | 'deny') => post<DeviceCodeInfo>(`/device/${encodeURIComponent(code)}/${d}`) });
  // Once the terminal collects its token the code is gone (404), so the decision made here wins.
  const decided = decide.data?.state ?? info.data?.state;
  const submit = (e: FormEvent) => (e.preventDefault(), setCode(typed.trim()));

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div className="page-header">
        <h1>
          <Terminal className="icon-inline" /> Sign in a device
        </h1>
      </div>
      <div className="card">
        <div className="card-body form">
          {decided === 'approved' ? (
            <div className="notice ok">Approved. Go back to your terminal; it’s signed in.</div>
          ) : decided === 'denied' ? (
            <div className="notice">Denied. Nothing was signed in.</div>
          ) : !code || info.isError ? (
            <form className="form" onSubmit={submit}>
              <label className="field">
                Code shown in your terminal
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="BCDF-GHJK" autoFocus autoComplete="off" className="mono" style={{ textTransform: 'uppercase' }} />
              </label>
              {info.isError && <div className="error-text">{errorText(info.error)}</div>}
              <button className="primary" type="submit" disabled={!USER_CODE.test(typed.trim())}>
                Continue
              </button>
            </form>
          ) : info.isPending ? (
            <div className="muted">Looking up the code…</div>
          ) : (
            <>
              {info.data!.fromYourAddress ? (
                <div className="notice warn">Only approve this if you just ran <code>snitch login</code> yourself and your terminal shows the same code.</div>
              ) : (
                <div className="notice danger" role="alert">
                  This request came from a different address than the one you’re browsing from. That’s expected over SSH or a VPN, but if someone sent you this link, deny it:
                  approving gives them access as you.
                </div>
              )}
              <dl className="facts">
                <dt>Code</dt>
                <dd className="mono" style={{ fontSize: 20, letterSpacing: 2, color: "var(--text)" }}>
                  {info.data!.userCode}
                </dd>
                <dt>Calls itself</dt>
                <dd>{info.data!.clientName}</dd>
                <dt>From</dt>
                <dd className="mono">{info.data!.ip ?? 'unknown'}</dd>
                <dt>Asked</dt>
                <dd>{dateTime(info.data!.createdAt)}</dd>
                <dt>It can</dt>
                <dd>
                  {info.data!.scopes.map((s) => (
                    <div key={s}>{SCOPE_LABEL[s]}</div>
                  ))}
                </dd>
                <dt>Until</dt>
                <dd>{info.data!.tokenDays === null ? 'You revoke it' : `${info.data!.tokenDays} days from now, or until you revoke it on the API tokens page`}</dd>
              </dl>
              <label className="check block">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I started this sign-in myself, and my terminal shows{' '}
                <span className="mono">{info.data!.userCode}</span>
              </label>
              {decide.isError && <div className="error-text">{errorText(decide.error)}</div>}
              <div className="row">
                <button type="button" className="primary" disabled={decide.isPending || !confirmed} onClick={() => decide.mutate('approve')}>
                  Approve
                </button>
                <button type="button" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
                  Deny
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
