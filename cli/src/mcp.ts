/**
 * `snitch mcp`: Snitch as an MCP server over stdio, so coding agents can read
 * reports the way a person does: the tester's words, the screenshot and video
 * frames as images, the timeline and logs as text. Two tools write (comment,
 * status) and say so in their annotations; `--read-only` leaves them out.
 *
 * It signs in like the CLI (SNITCH_TOKEN / SNITCH_URL, or `snitch login`), and
 * starts even when signed out, so the agent can tell the user what to run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TICKET_STATUSES, TIMELINE_ATTACHMENT, type TicketDetail, type TicketListQuery } from '@snitch/contract';
import { SnitchClient } from './client';
import { collectEvidence, defaultDir, downloadAttachments, extractFrames, fileName, renderTimeline, screenshotForModel, ticketSummary, UNTRUSTED } from './evidence';
import { VERSION } from './version';

export type ClientProvider = () => Promise<SnitchClient>;

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (e: unknown): CallToolResult => ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
const image = (path: string) => ({ type: 'image' as const, data: readFileSync(path).toString('base64'), mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' });

const ticketArg = z.string().min(1).describe('Ticket key (APP-12), ticket id, or a Snitch dashboard link');

export interface McpOptions {
  env?: NodeJS.ProcessEnv;
  /** Leave out the tools that change tickets (comment, status). */
  readOnly?: boolean;
}

export function buildMcpServer(getClient: ClientProvider, opts: McpOptions = {}): McpServer {
  const env = opts.env ?? process.env;
  const server = new McpServer(
    { name: 'snitch', version: VERSION },
    {
      instructions: [
        'Snitch holds QA reports sent from mobile apps: what the tester wrote, a screenshot, up to 30 s of screen recording, a timeline of logs, requests, screens and touches, and device details.',
        'Start with get_ticket (it includes the screenshot), then get_video_frames around the moment that matters and get_timeline for errors and requests.',
        UNTRUSTED,
      ].join(' '),
    },
  );

  const withClient =
    <A,>(fn: (client: SnitchClient, args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        return await fn(await getClient(), args);
      } catch (e) {
        return failure(e);
      }
    };

  /** A ticket's files, downloaded once into the cache and reused. */
  const files = async (client: SnitchClient, detail: TicketDetail) => {
    const dir = defaultDir(client.server, detail.ticket.key, env);
    return { dir, files: await downloadAttachments(client, detail, dir) };
  };

  server.registerTool(
    'list_tickets',
    {
      title: 'List Snitch tickets',
      description: 'Lists QA tickets, newest first. Defaults to open tickets.',
      inputSchema: {
        status: z.enum(['open', 'all', ...TICKET_STATUSES]).optional().describe('open (default), all, or one status'),
        type: z.string().optional().describe('Report type id, e.g. bug or idea'),
        project: z.string().optional().describe('Project slug or id'),
        search: z.string().optional().describe('Words in the title or description, or a ticket key'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { status?: string; type?: string; project?: string; search?: string; limit?: number }) => {
      const q: TicketListQuery = { status: (a.status ?? 'open') as TicketListQuery['status'], limit: a.limit ?? 25, ...(a.type ? { type: a.type } : {}), ...(a.search ? { q: a.search } : {}) };
      if (a.project) {
        const p = (await client.projects()).find((x) => x.slug === a.project || x.id === a.project);
        if (!p) return failure(`No project ${a.project}`);
        q.projectId = p.id;
      }
      const list = await client.tickets(q);
      if (!list.items.length) return text('No tickets match.');
      const rows = list.items.map(
        (t) => `${t.key}  [${t.type}, ${t.status}]  ${t.title}  · ${t.deviceModel}, ${t.appVersion} (${t.appBuild})${t.hasScreenshot ? ' · screenshot' : ''}${t.videoSeconds ? ` · ${t.videoSeconds} s video` : ''}${t.escalations.find((e) => e.url) ? ` · ${t.escalations.find((e) => e.url)!.url}` : ''}`,
      );
      return text([...rows, ...(list.nextCursor ? ['(more; raise limit or narrow the search)'] : [])].join('\n'));
    }),
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get a Snitch ticket',
      description: 'One QA report: what the tester wrote, app and device details, linked issues, comments, attachments, and the screenshot as an image.',
      inputSchema: { ticket: ticketArg, screenshot: z.boolean().optional().describe('Include the screenshot image (default true)') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; screenshot?: boolean }) => {
      const detail = await client.ticket(a.ticket);
      const content: CallToolResult['content'] = [{ type: 'text', text: ticketSummary(detail, client.server) }];
      const shot = detail.attachments.find((x) => x.name === 'screenshot' && x.stored);
      if (shot && a.screenshot !== false) {
        const { files: f } = await files(client, detail);
        content.push({ type: 'text', text: 'Screenshot at the moment of the report (the tester may have drawn on it):' }, image(await screenshotForModel(f.screenshot!)));
      }
      const video = detail.attachments.find((x) => x.name === 'video' && x.stored);
      if (video) content.push({ type: 'text', text: `There is a ${Math.round((video.durationMs ?? 0) / 1000)} s screen recording ending at the report: use get_video_frames.` });
      if (detail.attachments.some((x) => x.name === TIMELINE_ATTACHMENT && x.stored)) content.push({ type: 'text', text: 'There is a timeline of logs, requests, screens and touches: use get_timeline.' });
      return { content };
    }),
  );

  server.registerTool(
    'get_video_frames',
    {
      title: 'Frames from a report’s screen recording',
      description:
        'Stills from the screen recording as images, labelled with their second (0 = start of the clip; the clip ends at the report). Without a range it spreads `max` frames over the whole clip; narrow start/end to look closely. Needs ffmpeg where the server runs.',
      inputSchema: {
        ticket: ticketArg,
        start: z.number().min(0).optional().describe('First second'),
        end: z.number().min(0).optional().describe('Last second'),
        every: z.number().int().min(1).max(30).optional().describe('Seconds between frames (default 1)'),
        max: z.number().int().min(1).max(20).optional().describe('At most this many frames (default 8)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; start?: number; end?: number; every?: number; max?: number }) => {
      const detail = await client.ticket(a.ticket);
      const { dir, files: f } = await files(client, detail);
      if (!f.video) return text(`${detail.ticket.key} has no screen recording.`);
      const frames = await extractFrames(f.video, join(dir, 'mcp-frames'), { start: a.start, end: a.end, every: a.every, max: a.max ?? 8 });
      if (!frames.length) return text('No frames in that range.');
      const content: CallToolResult['content'] = [];
      for (const fr of frames) content.push({ type: 'text', text: `Second ${fr.second}` }, image(fr.path));
      return { content };
    }),
  );

  server.registerTool(
    'get_timeline',
    {
      title: 'A report’s timeline',
      description: 'Logs, network requests, screens, touches and app events before the report, one per line, with the second of the video each falls in (vNN).',
      inputSchema: {
        ticket: ticketArg,
        problems_only: z.boolean().optional().describe('Only errors, warnings and failed requests'),
        last: z.number().int().min(1).max(2000).optional().describe('Only the last N events (default 300)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; problems_only?: boolean; last?: number }) => {
      const detail = await client.ticket(a.ticket);
      const { files: f } = await files(client, detail);
      const sections: string[] = [];
      if (f[TIMELINE_ATTACHMENT]) {
        const r = renderTimeline(readFileSync(f[TIMELINE_ATTACHMENT], 'utf8'), detail);
        const lines = (a.problems_only ? r.problems : r.lines).slice(-(a.last ?? 300));
        sections.push(r.header, lines.length ? lines.join('\n') : a.problems_only ? 'No errors, warnings or failed requests.' : 'The timeline is empty.');
      } else sections.push('No timeline with this report.');
      if (f.logs && !a.problems_only) sections.push('', `Log text (${fileName({ name: 'logs', contentType: 'text/plain' })}, last 100 lines):`, ...readFileSync(f.logs, 'utf8').trimEnd().split('\n').slice(-100));
      sections.push('', UNTRUSTED);
      return text(sections.join('\n'));
    }),
  );

  server.registerTool(
    'download_ticket',
    {
      title: 'Download a report to disk',
      description: 'Saves everything (attachments, frames, timeline.txt, report.md, ticket.json) to a folder and returns the paths, for tools that work with files.',
      inputSchema: { ticket: ticketArg, dir: z.string().optional().describe('Parent folder; the files go in <dir>/<KEY> (default: the Snitch cache folder)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; dir?: string }) => {
      const detail = await client.ticket(a.ticket);
      // Always a folder of its own, so a `dir` like "." never mixes report files into a project.
      const ev = await collectEvidence(client, detail, a.dir ? join(a.dir, detail.ticket.key) : defaultDir(client.server, detail.ticket.key, env));
      return text([`Saved to ${ev.dir}`, `Start with ${ev.report}`, ...Object.values(ev.files), ...ev.sheets, ...ev.notes].join('\n'));
    }),
  );

  if (opts.readOnly) return server;

  server.registerTool(
    'comment_on_ticket',
    {
      title: 'Comment on a Snitch ticket',
      description: 'Adds a comment as the signed-in user (it also reaches the linked GitHub issue when comment sync is on). Needs the tickets:write scope.',
      inputSchema: { ticket: ticketArg, body: z.string().min(1).max(10_000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; body: string }) => {
      const detail = await client.ticket(a.ticket);
      await client.comment(detail.ticket.id, a.body);
      return text(`Commented on ${detail.ticket.key}.`);
    }),
  );

  server.registerTool(
    'set_ticket_status',
    {
      title: 'Change a Snitch ticket’s status',
      description:
        'Moves a ticket: new, triaged, in_progress, resolved, wont_fix or duplicate. Resolving can email the tester and close the linked issue. Prefer in_progress when a fix is only proposed. Needs the tickets:write scope.',
      inputSchema: {
        ticket: ticketArg,
        status: z.enum(TICKET_STATUSES),
        fixed_in: z.string().min(1).max(64).optional().describe('With resolved: the build the fix ships in'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    withClient(async (client, a: { ticket: string; status: (typeof TICKET_STATUSES)[number]; fixed_in?: string }) => {
      const detail = await client.ticket(a.ticket);
      await client.update(detail.ticket.id, { status: a.status, ...(a.fixed_in ? { fixedIn: a.fixed_in } : {}) });
      return text(`${detail.ticket.key} is now ${a.status}.`);
    }),
  );

  return server;
}

export async function runMcp(getClient: ClientProvider, opts: McpOptions = {}): Promise<void> {
  await buildMcpServer(getClient, opts).connect(new StdioServerTransport());
}
