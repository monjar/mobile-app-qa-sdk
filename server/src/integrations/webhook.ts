/**
 * Posts a ticket to a webhook: generic JSON (HMAC-signed), Slack or Discord.
 *
 * SSRF guard: the target host must resolve only to public addresses unless
 * SNITCH_ALLOW_PRIVATE_WEBHOOKS is set — otherwise any dashboard user could make
 * the server probe its own network (cloud metadata endpoints included).
 */
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { WebhookConfig, type WebhookPayload } from '@snitch/contract';
import type { Deps } from '../deps';
import type { IntegrationRow } from '../repo/integrations';
import type { TicketRow } from '../repo/tickets';
import { VERSION } from '../version';
import { buildTicketContext, type TicketContext } from './context';
import { classifyHttp, SendError } from './errors';
import type { SendResult } from './github';
import { discordMessage, slackMessage } from './render';

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]!);
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

export async function assertPublicUrl(deps: Deps, raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SendError('Webhook URL is invalid', false);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SendError('Webhook URL must be http(s)', false);
  if (deps.config.allowPrivateWebhooks) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : await deps.lookup(host).catch(() => [] as string[]);
  if (addrs.length === 0) throw new SendError(`Webhook host ${host} does not resolve`, true);
  if (addrs.some(isPrivateAddress)) throw new SendError(`Webhook host ${host} resolves to a private address (set SNITCH_ALLOW_PRIVATE_WEBHOOKS=true to allow)`, false);
  return url;
}

export function sign(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function genericPayload(event: WebhookPayload['event'], ctx: TicketContext, deps: Deps): WebhookPayload {
  const t = ctx.render.ticket;
  return {
    event,
    sentAt: new Date(deps.now()).toISOString(),
    project: ctx.project,
    ticket: {
      id: t.id,
      key: ctx.render.key,
      type: t.type,
      title: t.title,
      description: t.description,
      status: t.status,
      url: ctx.render.dashboardUrl,
      platform: t.platform,
      releaseType: t.release_type as WebhookPayload['ticket']['releaseType'],
      app: { id: t.app_id, version: t.app_version, build: t.app_build },
      device: { model: t.device_model, osVersion: t.os_version },
      reporterEmail: t.reporter_email,
      attachments: ctx.attachments
        .filter((a) => a.state === 'stored')
        .map((a) => ({
          name: a.name,
          contentType: a.content_type,
          url: a.id === ctx.screenshot?.id ? (ctx.render.links.screenshot ?? null) : a.id === ctx.video?.id ? (ctx.render.links.video ?? null) : null,
        })),
    },
  };
}

async function post(deps: Deps, integration: IntegrationRow, url: URL, body: string, extraHeaders: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `snitch-server/${VERSION}`, ...extraHeaders },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new SendError(`Webhook request failed: ${(e as Error).message}`, true);
  }
  const text = await res.text().catch(() => '');
  if (res.status >= 300 && res.status < 400) throw new SendError(`Webhook redirected (HTTP ${res.status}); redirects are not followed`, false);
  if (!res.ok) throw classifyHttp(res, `Webhook ${integration.name}`, text);
}

export async function sendWebhook(deps: Deps, integration: IntegrationRow, ticket: TicketRow, userId: string | null, event: WebhookPayload['event'] = 'ticket.escalated'): Promise<SendResult> {
  const cfg = WebhookConfig.parse(JSON.parse(integration.config_json));
  const url = await assertPublicUrl(deps, cfg.url);
  const ctx = buildTicketContext(deps, ticket, { enabled: cfg.includeShareLinks, ttlDays: cfg.shareTtlDays, userId, integration });
  let body: string;
  const extra: Record<string, string> = {};
  if (cfg.format === 'slack') body = JSON.stringify(slackMessage(ctx.render));
  else if (cfg.format === 'discord') body = JSON.stringify(discordMessage(ctx.render));
  else {
    body = JSON.stringify(genericPayload(event, ctx, deps));
    const ts = String(Math.floor(deps.now() / 1000));
    extra['x-snitch-event'] = event;
    extra['x-snitch-timestamp'] = ts;
    const secret = deps.integrations.secret(integration);
    if (secret) extra['x-snitch-signature'] = sign(secret, ts, body);
  }
  await post(deps, integration, url, body, extra);
  return { externalId: null, externalUrl: null };
}

export async function testWebhook(deps: Deps, integration: IntegrationRow): Promise<string> {
  const cfg = WebhookConfig.parse(JSON.parse(integration.config_json));
  const url = await assertPublicUrl(deps, cfg.url);
  const text = `Snitch test message from ${deps.config.publicUrl} — escalations from "${integration.name}" will arrive here.`;
  let body: string;
  const extra: Record<string, string> = {};
  if (cfg.format === 'slack') body = JSON.stringify({ text });
  else if (cfg.format === 'discord') body = JSON.stringify({ content: text, allowed_mentions: { parse: [] } });
  else {
    body = JSON.stringify({ event: 'integration.test', sentAt: new Date(deps.now()).toISOString(), message: text });
    const ts = String(Math.floor(deps.now() / 1000));
    extra['x-snitch-event'] = 'integration.test';
    extra['x-snitch-timestamp'] = ts;
    const secret = deps.integrations.secret(integration);
    if (secret) extra['x-snitch-signature'] = sign(secret, ts, body);
  }
  await post(deps, integration, url, body, extra);
  return `Delivered a test message to ${url.host}`;
}
