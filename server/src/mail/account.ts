/**
 * Invite and password-reset links: a one-time token (AccountTokensRepo) in a
 * link to the dashboard's /set-password page, sent by email.
 *
 * Without SMTP nothing can be emailed, so the link comes back to the admin who
 * asked for it (AccountLink.emailed = false) to pass on themselves. A
 * self-service "Forgot password?" request has no admin to hand it to: the
 * dashboard only offers it when SMTP is configured.
 */
import type { AccountLink, AccountTokenPurpose } from '@snitch/contract';
import type { Deps } from '../deps';
import { escapeHtml } from '../integrations/render';
import { errorMessage, log } from '../log';
import type { UserRow } from '../repo/users';
import { DAY_MS, HOUR_MS } from '../util/clock';
import { card } from './notifications';

/** How long each kind of link works. An admin-sent reset link lasts longer than a self-service one. */
export const LINK_TTL = {
  invite: 7 * DAY_MS,
  selfReset: HOUR_MS,
  adminReset: DAY_MS,
} as const;

export function setPasswordUrl(deps: Deps, token: string): string {
  return `${deps.config.publicUrl}/set-password?token=${encodeURIComponent(token)}`;
}

function durationText(ms: number): string {
  if (ms % DAY_MS === 0) return ms === DAY_MS ? '24 hours' : `${ms / DAY_MS} days`;
  return ms === HOUR_MS ? '1 hour' : `${Math.round(ms / HOUR_MS)} hours`;
}

function button(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">${escapeHtml(label)}</a>`;
}

export function inviteEmail(o: { inviter: string; url: string; validFor: string; serverUrl: string }): { subject: string; text: string; html: string } {
  const subject = `${o.inviter} invited you to Snitch`.slice(0, 200);
  const text = [
    `${o.inviter} invited you to Snitch, where your team triages bug reports from the app.`,
    '',
    `Choose a password to get started: ${o.url}`,
    '',
    `The link works once, for ${o.validFor}. Snitch: ${o.serverUrl}`,
  ].join('\n');
  const html = card(
    `<tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">You're invited to Snitch</td></tr>
<tr><td style="font-size:14px;line-height:1.5;padding-bottom:16px">${escapeHtml(o.inviter)} invited you to Snitch, where your team triages bug reports from the app.</td></tr>
<tr><td style="padding-bottom:16px">${button(o.url, 'Choose a password')}</td></tr>
<tr><td style="font-size:12px;color:#6e6e73">The link works once, for ${escapeHtml(o.validFor)}. Snitch: ${escapeHtml(o.serverUrl)}</td></tr>`,
  );
  return { subject, text, html };
}

export function resetEmail(o: { url: string; validFor: string; byAdmin: string | null }): { subject: string; text: string; html: string } {
  const subject = 'Reset your Snitch password';
  const why = o.byAdmin ? `${o.byAdmin} sent you a link to reset your Snitch password.` : 'Someone (hopefully you) asked to reset your Snitch password.';
  const ignore = o.byAdmin ? '' : " If it wasn't you, ignore this email: your password stays as it is.";
  const text = [why, '', `Choose a new password: ${o.url}`, '', `The link works once, for ${o.validFor}.${ignore}`].join('\n');
  const html = card(
    `<tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">Reset your password</td></tr>
<tr><td style="font-size:14px;line-height:1.5;padding-bottom:16px">${escapeHtml(why)}</td></tr>
<tr><td style="padding-bottom:16px">${button(o.url, 'Choose a new password')}</td></tr>
<tr><td style="font-size:12px;color:#6e6e73">The link works once, for ${escapeHtml(o.validFor)}.${escapeHtml(ignore)}</td></tr>`,
  );
  return { subject, text, html };
}

/**
 * Creates a link for `user` and emails it. Never throws on the email: the result says whether it went out.
 * `actor` is the admin who asked (invites, admin resets), or null for a self-service reset.
 */
export async function sendAccountLink(deps: Deps, user: UserRow, purpose: AccountTokenPurpose, ttlMs: number, actor: UserRow | null): Promise<AccountLink> {
  const { token, expiresAt } = deps.accountTokens.create(user.id, purpose, ttlMs, actor?.id ?? null);
  const url = setPasswordUrl(deps, token);
  const validFor = durationText(ttlMs);
  const actorName = actor ? (actor.name ?? actor.email) : null;
  const msg =
    purpose === 'invite'
      ? inviteEmail({ inviter: actorName ?? 'Your team', url, validFor, serverUrl: deps.config.publicUrl })
      : resetEmail({ url, validFor, byAdmin: actorName });
  if (deps.mailer.driver === 'console') {
    return { url, expiresAt, emailed: false, error: 'This server has no SMTP configured (SNITCH_SMTP_URL), so nothing was emailed.' };
  }
  try {
    await deps.mailer.send({ to: [user.email], ...msg });
    return { url, expiresAt, emailed: true, error: null };
  } catch (e) {
    log.warn('mail', `could not send the ${purpose} email`, { userId: user.id, error: errorMessage(e) });
    return { url, expiresAt, emailed: false, error: `The email couldn't be sent: ${errorMessage(e)}` };
  }
}
