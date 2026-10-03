/**
 * Emails a ticket. The screenshot rides along inline (CID), so the email is
 * useful even when the Snitch server isn't reachable from the reader's network.
 * The video is linked (share link if enabled, else the dashboard).
 */
import { EmailConfig } from '@snitch/contract';
import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import type { TicketRow } from '../repo/tickets';
import { buildTicketContext } from './context';
import { SendError } from './errors';
import { email, escapeHtml } from './render';
import type { SendResult } from './github';

const INLINE_LIMIT = 8 * 1024 * 1024;

export async function sendEmail(deps: Deps, integration: IntegrationRow, ticket: TicketRow, userId: string | null): Promise<SendResult> {
  if (deps.mailer.driver === 'console') throw new SendError('Mail is not configured on this server (set SNITCH_SMTP_URL)', false);
  const cfg = EmailConfig.parse(JSON.parse(integration.config_json));
  const ctx = buildTicketContext(deps, ticket, { enabled: false, ttlDays: 30, userId, integration });
  let inline: { cid: string; content: Buffer; contentType: string; filename: string } | null = null;
  if (ctx.screenshot?.storage_key && (ctx.screenshot.size_bytes ?? 0) <= INLINE_LIMIT) {
    try {
      inline = {
        cid: `screenshot-${ticket.id}@snitch`,
        content: await deps.blobs.readAll(ctx.screenshot.storage_key),
        contentType: ctx.screenshot.content_type,
        filename: ctx.screenshot.content_type === 'image/png' ? 'screenshot.png' : 'screenshot.jpg',
      };
    } catch {
      inline = null;
    }
  }
  const msg = email(ctx.render, cfg.subjectPrefix, inline?.cid ?? null);
  try {
    const r = await deps.mailer.send({ to: cfg.to, ...msg, attachments: inline ? [inline] : [] });
    return { externalId: r.messageId, externalUrl: null };
  } catch (e) {
    throw new SendError(`SMTP send failed: ${(e as Error).message}`, true);
  }
}

export async function testEmail(deps: Deps, integration: IntegrationRow): Promise<string> {
  if (deps.mailer.driver === 'console') throw new SendError('Mail is not configured on this server (set SNITCH_SMTP_URL)', false);
  const cfg = EmailConfig.parse(JSON.parse(integration.config_json));
  await deps.mailer.send({
    to: cfg.to,
    subject: `${cfg.subjectPrefix} Test message`.trim(),
    text: `This is a test from Snitch (${deps.config.publicUrl}). Escalations from "${integration.name}" will arrive like this.`,
    html: `<p>This is a test from Snitch (<a href="${escapeHtml(deps.config.publicUrl)}">${escapeHtml(deps.config.publicUrl)}</a>).</p><p>Escalations from “${escapeHtml(integration.name)}” will arrive like this.</p>`,
  });
  return `Sent a test message to ${cfg.to.join(', ')}`;
}
