/**
 * Renders a ticket for the outside world: GitHub markdown, email HTML/text,
 * chat messages. Everything user-supplied is escaped for its target format.
 */
import type { TicketMetadata, TicketRow } from '../repo/tickets';

export interface RenderInput {
  key: string;
  ticket: TicketRow;
  meta: TicketMetadata;
  typeLabel: string;
  projectName: string;
  dashboardUrl: string;
  /** Public share links, only when the integration opted in. */
  links: { screenshot?: string; video?: string };
  hasScreenshot: boolean;
  videoSeconds: number | null;
}

export function deviceLine(i: RenderInput): string {
  const m = i.meta;
  const os = m.device.platform === 'ios' ? 'iOS' : 'Android';
  return `${m.device.model} · ${os} ${m.device.osVersion}`;
}

export function metadataRows(i: RenderInput): [string, string][] {
  const m = i.meta;
  const rows: [string, string][] = [
    ['App', `${m.app.name ?? m.app.id} ${m.app.version} (${m.app.build})`],
    ['Release', m.app.releaseType],
    ['Device', deviceLine(i)],
  ];
  if (m.device.locale) rows.push(['Locale', m.device.locale]);
  if (m.device.network) rows.push(['Network', m.device.network]);
  if (m.device.memory?.appMB !== undefined) rows.push(['App memory', `${Math.round(m.device.memory.appMB)} MB`]);
  if (m.device.battery !== undefined) rows.push(['Battery', `${Math.round(m.device.battery * 100)}%${m.device.charging ? ' (charging)' : ''}`]);
  if (i.ticket.reporter_email) rows.push(['Reporter', i.ticket.reporter_email]);
  rows.push(['SDK', `${m.sdk.name} ${m.sdk.version}${m.sdk.wrapper ? ` via ${m.sdk.wrapper} ${m.sdk.wrapperVersion ?? ''}`.trimEnd() : ''}`]);
  for (const [k, v] of Object.entries(m.custom)) rows.push([k, v]);
  return rows;
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export const GITHUB_MARKER = (ticketId: string) => `<!-- snitch:ticket=${ticketId} -->`;

export function githubIssue(i: RenderInput): { title: string; body: string } {
  const title = `[${i.typeLabel}] ${i.key}: ${i.ticket.title}`.slice(0, 250);
  const quote = i.ticket.description.trim()
    ? i.ticket.description
        .trim()
        .split(/\r?\n/)
        .map((l) => `> ${l}`)
        .join('\n')
    : '> _(no description)_';
  const media: string[] = [];
  if (i.links.screenshot) media.push(`<img src="${i.links.screenshot}" alt="Screenshot" width="320">`);
  if (i.links.video) media.push(`🎬 [Screen recording (${i.videoSeconds ?? '?'} s)](${i.links.video})`);
  if (!i.links.screenshot && i.hasScreenshot) media.push('📷 Screenshot attached in Snitch');
  if (!i.links.video && i.videoSeconds) media.push(`🎬 ${i.videoSeconds} s screen recording attached in Snitch`);
  const body = [
    quote,
    '',
    ...(media.length ? [media.join('\n\n'), ''] : []),
    '| | |',
    '|---|---|',
    ...metadataRows(i).map(([k, v]) => `| ${mdCell(k)} | ${mdCell(v)} |`),
    '',
    `[Open ${i.key} in Snitch](${i.dashboardUrl})`,
    '',
    GITHUB_MARKER(i.ticket.id),
  ].join('\n');
  return { title, body };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function email(i: RenderInput, subjectPrefix: string, inlineScreenshotCid: string | null): { subject: string; text: string; html: string } {
  const subject = `${subjectPrefix} ${i.key} ${i.typeLabel}: ${i.ticket.title}`.trim().slice(0, 200);
  const rows = metadataRows(i);
  const text = [
    `${i.key} · ${i.typeLabel} · ${i.projectName}`,
    '',
    i.ticket.description.trim() || '(no description)',
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(i.links.video ? [`Screen recording: ${i.links.video}`, ''] : i.videoSeconds ? [`Screen recording (${i.videoSeconds} s) attached in Snitch`, ''] : []),
    `Open in Snitch: ${i.dashboardUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<tr><td style="font-size:12px;color:#6e6e73;padding-bottom:8px">${escapeHtml(i.projectName)} · ${escapeHtml(i.typeLabel)} · ${escapeHtml(i.key)}</td></tr>
<tr><td style="font-size:18px;font-weight:600;padding-bottom:12px">${escapeHtml(i.ticket.title)}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;white-space:pre-wrap;padding-bottom:16px">${escapeHtml(i.ticket.description.trim() || '(no description)')}</td></tr>
${inlineScreenshotCid ? `<tr><td style="padding-bottom:16px"><img src="cid:${inlineScreenshotCid}" alt="Screenshot" style="max-width:280px;border-radius:8px;border:1px solid #e5e5ea"></td></tr>` : ''}
${i.links.video ? `<tr><td style="padding-bottom:16px;font-size:14px"><a href="${escapeHtml(i.links.video)}">Screen recording (${i.videoSeconds ?? '?'} s)</a></td></tr>` : ''}
<tr><td><table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;width:100%">
${rows.map(([k, v]) => `<tr><td style="color:#6e6e73;padding:3px 12px 3px 0;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:3px 0">${escapeHtml(v)}</td></tr>`).join('\n')}
</table></td></tr>
<tr><td style="padding-top:20px"><a href="${escapeHtml(i.dashboardUrl)}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px">Open in Snitch</a></td></tr>
</table></body></html>`;
  return { subject, text, html };
}

/** Slack incoming-webhook message (mrkdwn escaping: &, <, >). */
export function slackMessage(i: RenderInput): Record<string, unknown> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const desc = i.ticket.description.trim() || '_(no description)_';
  const fields = metadataRows(i)
    .slice(0, 8)
    .map(([k, v]) => ({ type: 'mrkdwn', text: `*${esc(k)}*\n${esc(v)}` }));
  const links = [`<${i.dashboardUrl}|Open ${i.key}>`];
  if (i.links.screenshot) links.push(`<${i.links.screenshot}|Screenshot>`);
  if (i.links.video) links.push(`<${i.links.video}|Recording>`);
  return {
    text: `${i.key} ${i.typeLabel}: ${esc(i.ticket.title)}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${esc(i.key)} · ${esc(i.typeLabel)}* — ${esc(i.ticket.title)}` } },
      { type: 'section', text: { type: 'mrkdwn', text: esc(desc).slice(0, 2900) } },
      { type: 'section', fields },
      { type: 'context', elements: [{ type: 'mrkdwn', text: links.join(' · ') }] },
    ],
  };
}

/** Discord webhook message. */
export function discordMessage(i: RenderInput): Record<string, unknown> {
  const fields = metadataRows(i)
    .slice(0, 10)
    .map(([name, value]) => ({ name: name.slice(0, 256), value: value.slice(0, 1024) || '—', inline: true }));
  return {
    content: `**${i.key} · ${i.typeLabel}** — ${i.ticket.title}`.slice(0, 2000),
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: i.ticket.title.slice(0, 256),
        url: i.dashboardUrl,
        description: (i.ticket.description.trim() || '(no description)').slice(0, 4000),
        fields,
        ...(i.links.screenshot ? { image: { url: i.links.screenshot } } : {}),
      },
    ],
  };
}
