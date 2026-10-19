/**
 * `snitch mcp`: Snitch as an MCP server over stdio, so coding agents can work
 * reports the way a person does: read the tester's words, the screenshot and
 * video frames as images, the timeline and logs as text, the ticket's history
 * and likely duplicates, the builds testers run; then comment, move, assign,
 * retitle, mark duplicates and open GitHub issues. Tools that change tickets
 * say so in their annotations, and `--read-only` leaves them out.
 *
 * It also serves the snitch-fix skill: as prompts (`fix_reports`,
 * `triage_reports`) for agents without skills, and its files as resources.
 *
 * It signs in like the CLI (SNITCH_TOKEN / SNITCH_URL, or `snitch login`), and
 * starts even when signed out, so the agent can tell the user what to run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PLATFORMS, RELEASE_TYPES, TICKET_STATUSES, TIMELINE_ATTACHMENT, type ProjectView, type TicketDetail, type TicketListQuery } from '@snitch/contract';
import { SnitchClient } from './client';
import {
  activityLines,
  collectEvidence,
  defaultDir,
  downloadAttachments,
  extractFrames,
  fileName,
  renderTimeline,
  screenshotForModel,
  ticketSummary,
  UNTRUSTED,
} from './evidence';
import { detectProject, fillTemplate, SKILL_NAME, templateFiles } from './skill';
import { VERSION } from './version';

export type ClientProvider = () => Promise<SnitchClient>;

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const failure = (e: unknown): CallToolResult => ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
const image = (path: string) => ({ type: 'image' as const, data: readFileSync(path).toString('base64'), mimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg' });
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const ticketArg = z.string().min(1).describe('Ticket key (APP-12), ticket id, or a Snitch dashboard link');
const projectArg = z.string().optional().describe('Project slug or id (needed only when the server has several)');

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

/** Text matching for search arguments: /regex/flags, or words matched case-insensitively. */
function matcher(search: string): (s: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(search);
  if (re) {
    const r = new RegExp(re[1]!, re[2]!.includes('i') ? re[2] : `${re[2]}i`);
    return (s) => r.test(s);
  }
  const needle = search.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

async function pickProject(client: SnitchClient, ref?: string): Promise<ProjectView> {
  const projects = await client.projects();
  if (ref) {
    const p = projects.find((x) => x.slug === ref || x.id === ref || x.ticketPrefix === ref.toUpperCase());
    if (!p) throw new Error(`No project ${ref}. Projects: ${projects.map((x) => x.slug).join(', ')}`);
    return p;
  }
  if (projects.length === 1) return projects[0]!;
  throw new Error(`Which project? ${projects.map((x) => `${x.slug} (${x.ticketPrefix})`).join(', ')}`);
}

/** A user id for "me", "nobody", an email or a name; null for nobody. */
async function personId(client: SnitchClient, who: string): Promise<{ id: string | null; label: string }> {
  const w = who.trim().toLowerCase();
  if (['nobody', 'none', 'unassigned', ''].includes(w)) return { id: null, label: 'nobody' };
  if (w === 'me') {
    const me = (await client.whoami()).user;
    return { id: me.id, label: me.name ?? me.email };
  }
  const people = (await client.users()).filter((u) => !u.disabled);
  const hits = people.filter((u) => u.email.toLowerCase() === w || u.id.toLowerCase() === w);
  const byName = hits.length ? hits : people.filter((u) => (u.name ?? '').toLowerCase().includes(w) || u.email.toLowerCase().startsWith(w));
  if (byName.length === 1) return { id: byName[0]!.id, label: byName[0]!.name ?? byName[0]!.email };
  const list = people.map((u) => (u.name ? `${u.name} <${u.email}>` : u.email)).join(', ');
  throw new Error(byName.length ? `"${who}" matches several people: ${byName.map((u) => u.email).join(', ')}` : `Nobody called "${who}". The team: ${list}`);
}

export interface McpOptions {
  env?: NodeJS.ProcessEnv;
  /** Leave out the tools that change tickets. */
  readOnly?: boolean;
  /** The project the agent works in, for filling in the skill's prompts (default: the current directory). */
  cwd?: string;
}

export function buildMcpServer(getClient: ClientProvider, opts: McpOptions = {}): McpServer {
  const env = opts.env ?? process.env;
  const server = new McpServer(
    { name: 'snitch', version: VERSION },
    {
      instructions: [
        'Snitch holds QA reports sent from mobile apps: what the tester wrote, a screenshot, up to 30 s of screen recording, a timeline of logs, requests, screens and touches, and device details.',
        'Start with get_ticket (it includes the screenshot), then get_video_frames around the moment that matters, get_timeline and get_logs for errors and requests, and get_ticket_activity for comments and pull requests already made.',
        'To fix reports end to end (evidence, reproduction, test-first fix, one pull request each), use the fix_reports prompt, or the snitch-fix skill when the project has it.',
        'Leave resolving to a person: it means the fix shipped. Use in_progress when a fix is proposed.',
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

  // ── Who and where ─────────────────────────────────────────────────────────

  server.registerTool(
    'whoami',
    {
      title: 'Who Snitch sees',
      description: 'The signed-in account, the server and its version, and what the token may do. Call it first: it says how to sign in when signed out.',
      inputSchema: {},
      annotations: READ,
    },
    withClient(async (client) => {
      const me = await client.whoami();
      const scopes = me.token?.scopes ?? ['tickets:read', 'tickets:write'];
      return text(
        [
          `Signed in to ${client.server} (Snitch ${me.server.version}) as ${me.user.name ? `${me.user.name} <${me.user.email}>` : me.user.email}, ${me.user.role}.`,
          me.token ? `Token “${me.token.name}”: ${scopes.join(', ')}${me.token.expiresAt ? `, until ${day(me.token.expiresAt)}` : ', never expires'}.` : 'Browser session.',
          ...(scopes.includes('tickets:write') ? [] : ['This token can read but not change tickets (sign in again without --read-only to comment or move them).']),
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List Snitch projects',
      description: 'Projects on the server: slug, name, ticket key prefix, report types and how many tickets are open.',
      inputSchema: {},
      annotations: READ,
    },
    withClient(async (client) => {
      const projects = await client.projects();
      if (!projects.length) return text('No projects.');
      return text(projects.map((p) => `${p.slug}  ${p.name}  · keys ${p.ticketPrefix}-n · ${p.openTickets} open · types: ${p.reportTypes.map((r) => r.id).join(', ')}`).join('\n'));
    }),
  );

  server.registerTool(
    'list_builds',
    {
      title: 'Builds testers run',
      description:
        'App builds seen from installs (the SDK checks in), newest first: version, build number, installs per release type, reports. Use it to tell whether a report comes from an old build, and which build to name when a fix ships.',
      inputSchema: {
        project: projectArg,
        platform: z.enum(PLATFORMS).optional(),
        since_days: z.number().int().min(1).max(365).optional().describe('Only builds seen in the last N days (default 30)'),
      },
      annotations: READ,
    },
    withClient(async (client, a: { project?: string; platform?: (typeof PLATFORMS)[number]; since_days?: number }) => {
      const p = await pickProject(client, a.project);
      const { builds } = await client.devices(p.id, { ...(a.platform ? { platform: a.platform } : {}), sinceDays: a.since_days ?? 30, limit: 1 });
      if (!builds.length) return text(`No installs of ${p.name} checked in${a.since_days ? '' : ' in the last 30 days'}. (Check-ins need the SDK's \`checkin\` feature.)`);
      const rows = [...builds]
        .sort((x, y) => y.lastSeenAt - x.lastSeenAt)
        .map((b) => {
          const types = Object.entries(b.releaseTypes).map(([k, n]) => `${k} ${n}`).join(', ');
          return `${b.platform} ${b.appVersion} (${b.build})  · ${b.installs} install${b.installs === 1 ? '' : 's'}${types ? ` (${types})` : ''}${b.inactive ? `, ${b.inactive} inactive` : ''} · ${b.reports} report${b.reports === 1 ? '' : 's'} · last seen ${day(b.lastSeenAt)}`;
        });
      return text(rows.join('\n'));
    }),
  );

  // ── Tickets ───────────────────────────────────────────────────────────────

  server.registerTool(
    'list_tickets',
    {
      title: 'List Snitch tickets',
      description: 'QA tickets, newest first, with the counts per status. Defaults to open tickets.',
      inputSchema: {
        status: z.enum(['open', 'all', ...TICKET_STATUSES]).optional().describe('open (default), all, or one status'),
        type: z.string().optional().describe('Report type id, e.g. bug or idea'),
        project: projectArg,
        platform: z.enum(PLATFORMS).optional(),
        release_type: z.enum(RELEASE_TYPES).optional().describe('e.g. testflight, play, debug'),
        assignee: z.string().optional().describe('"me", "none", or a teammate’s email or name'),
        search: z.string().optional().describe('Words in the title or description, or a ticket key'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
        cursor: z.string().optional().describe('From a previous call, for the next page'),
      },
      annotations: READ,
    },
    withClient(
      async (
        client,
        a: { status?: string; type?: string; project?: string; platform?: (typeof PLATFORMS)[number]; release_type?: (typeof RELEASE_TYPES)[number]; assignee?: string; search?: string; limit?: number; cursor?: string },
      ) => {
        const q: TicketListQuery = {
          status: (a.status ?? 'open') as TicketListQuery['status'],
          limit: a.limit ?? 25,
          ...(a.type ? { type: a.type } : {}),
          ...(a.search ? { q: a.search } : {}),
          ...(a.platform ? { platform: a.platform } : {}),
          ...(a.release_type ? { releaseType: a.release_type } : {}),
          ...(a.cursor ? { cursor: a.cursor } : {}),
        };
        if (a.project) q.projectId = (await pickProject(client, a.project)).id;
        if (a.assignee) q.assignee = ['none', 'nobody', 'unassigned'].includes(a.assignee.toLowerCase()) ? 'none' : ((await personId(client, a.assignee)).id ?? 'none');
        const list = await client.tickets(q);
        const counts = Object.entries(list.counts)
          .filter(([, n]) => n)
          .map(([k, n]) => `${k} ${n}`)
          .join(', ');
        if (!list.items.length) return text(`No tickets match.${counts ? ` (All: ${counts}.)` : ''}`);
        const rows = list.items.map((t) => {
          const linked = t.escalations.find((e) => e.url)?.url;
          return `${t.key}  [${t.type}, ${t.status}]  ${t.title}  · ${t.platform} ${t.deviceModel}, ${t.appVersion} (${t.appBuild})${t.screen ? ` · on ${t.screen}` : ''}${t.hasScreenshot ? ' · screenshot' : ''}${t.videoSeconds ? ` · ${t.videoSeconds} s video` : ''}${t.assignee ? ` · ${t.assignee.name ?? t.assignee.email}` : ''}${linked ? ` · ${linked}` : ''}`;
        });
        return text([...rows, ...(counts ? [`(${counts})`] : []), ...(list.nextCursor ? [`More: call again with cursor "${list.nextCursor}".`] : [])].join('\n'));
      },
    ),
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get a Snitch ticket',
      description: 'One QA report: what the tester wrote, app and device details, linked issues and pull requests, latest comments, attachments, and the screenshot as an image.',
      inputSchema: { ticket: ticketArg, screenshot: z.boolean().optional().describe('Include the screenshot image (default true)') },
      annotations: READ,
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
      if (detail.attachments.some((x) => x.name === 'logs' && x.stored)) content.push({ type: 'text', text: 'There is log text: use get_logs to search it.' });
      return { content };
    }),
  );

  server.registerTool(
    'get_ticket_activity',
    {
      title: 'A ticket’s history',
      description:
        'Everything that happened to a ticket, oldest first: status changes, assignments, comments in Snitch and on the GitHub issue, escalations, pull requests that link the issue, duplicates, emails sent. Use it to see whether a fix is already in flight.',
      inputSchema: { ticket: ticketArg, last: z.number().int().min(1).max(500).optional().describe('Only the last N events (default 100)') },
      annotations: READ,
    },
    withClient(async (client, a: { ticket: string; last?: number }) => {
      const detail = await client.ticket(a.ticket);
      const lines = activityLines(detail).slice(-(a.last ?? 100));
      return text([`${detail.ticket.key}: ${detail.ticket.title} (${detail.ticket.status})`, ...lines, '', UNTRUSTED].join('\n'));
    }),
  );

  server.registerTool(
    'get_similar_tickets',
    {
      title: 'Tickets that look like the same problem',
      description: 'Open tickets from the last 60 days that resemble this one, best first, with a score and why (same screen, same build, similar words). Look at both before calling one a duplicate.',
      inputSchema: { ticket: ticketArg },
      annotations: READ,
    },
    withClient(async (client, a: { ticket: string }) => {
      const detail = await client.ticket(a.ticket);
      const lines = detail.similar.map((s) => `${s.key}  [${s.status}]  ${s.title}  · ${Math.round(s.score * 100)}% · ${s.reasons.join(', ')} · ${day(s.createdAt)}`);
      const of = detail.events.findLast((e) => e.kind === 'duplicate_marked')?.data.key ?? detail.ticket.duplicateOfId;
      const dup = detail.ticket.duplicateOfId ? [`${detail.ticket.key} is already marked a duplicate of ${String(of)}.`] : [];
      return text([...dup, ...(lines.length ? lines : ['Nothing similar is open.'])].join('\n'));
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
      annotations: READ,
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
      description:
        'Logs, network requests, screens, touches and app events before the report, one per line, with the second of the video each falls in (vNN, matching get_video_frames). Filter by kind, text, or a stretch of the video.',
      inputSchema: {
        ticket: ticketArg,
        problems_only: z.boolean().optional().describe('Only errors, warnings and failed requests'),
        kinds: z.array(z.enum(['log', 'net', 'screen', 'touch', 'app'])).optional().describe('Only these kinds of event'),
        search: z.string().optional().describe('Only lines with these words, or a /regex/'),
        start: z.number().min(0).optional().describe('Only events from this second of the video on'),
        end: z.number().min(0).optional().describe('Only events up to this second of the video'),
        last: z.number().int().min(1).max(2000).optional().describe('Only the last N matching events (default 300)'),
      },
      annotations: READ,
    },
    withClient(async (client, a: { ticket: string; problems_only?: boolean; kinds?: string[]; search?: string; start?: number; end?: number; last?: number }) => {
      const detail = await client.ticket(a.ticket);
      const { files: f } = await files(client, detail);
      const sections: string[] = [];
      const filtered = Boolean(a.problems_only || a.kinds?.length || a.search || a.start !== undefined || a.end !== undefined);
      if (f[TIMELINE_ATTACHMENT]) {
        const r = renderTimeline(readFileSync(f[TIMELINE_ATTACHMENT], 'utf8'), detail);
        const match = a.search ? matcher(a.search) : null;
        const lines = r.entries
          .filter((e) => (!a.problems_only || e.problem) && (!a.kinds?.length || a.kinds.includes(e.kind)) && (!match || match(e.line)))
          .filter((e) => (a.start === undefined && a.end === undefined) || (e.video !== null && e.video >= (a.start ?? 0) && e.video <= (a.end ?? Infinity)))
          .map((e) => e.line)
          .slice(-(a.last ?? 300));
        sections.push(r.header, lines.length ? lines.join('\n') : filtered ? 'No events match.' : 'The timeline is empty.');
      } else sections.push('No timeline with this report.');
      if (f.logs && !filtered) sections.push('', `Log text (${fileName({ name: 'logs', contentType: 'text/plain' })}, last 100 lines; get_logs searches all of it):`, ...readFileSync(f.logs, 'utf8').trimEnd().split('\n').slice(-100));
      sections.push('', UNTRUSTED);
      return text(sections.join('\n'));
    }),
  );

  server.registerTool(
    'get_logs',
    {
      title: 'Search a report’s log text',
      description: 'The log text the app sent with the report (native and JavaScript logs), with line numbers: the last lines, or the lines matching a search with some context.',
      inputSchema: {
        ticket: ticketArg,
        search: z.string().optional().describe('Words, or a /regex/'),
        context: z.number().int().min(0).max(20).optional().describe('Lines around each match (default 2)'),
        last: z.number().int().min(1).max(2000).optional().describe('At most this many lines (default 200)'),
      },
      annotations: READ,
    },
    withClient(async (client, a: { ticket: string; search?: string; context?: number; last?: number }) => {
      const detail = await client.ticket(a.ticket);
      const { files: f } = await files(client, detail);
      if (!f.logs) return text(`${detail.ticket.key} has no log text. The timeline's log lines are in get_timeline with kinds ["log"].`);
      const all = readFileSync(f.logs, 'utf8').trimEnd().split('\n');
      const num = (i: number) => `${String(i + 1).padStart(5)}  ${all[i]}`;
      let out: string[];
      if (a.search) {
        const match = matcher(a.search);
        const ctx = a.context ?? 2;
        const keep = new Set<number>();
        all.forEach((l, i) => {
          if (match(l)) for (let j = Math.max(0, i - ctx); j <= Math.min(all.length - 1, i + ctx); j++) keep.add(j);
        });
        const idx = [...keep].sort((x, y) => x - y);
        out = idx.flatMap((i, n) => (n && i !== idx[n - 1]! + 1 ? ['   …', num(i)] : [num(i)]));
        if (!out.length) return text(`No lines match "${a.search}" in ${all.length} lines of log text.`);
      } else out = all.map((_, i) => num(i));
      return text([`${all.length} lines of log text:`, ...out.slice(-(a.last ?? 200)), '', UNTRUSTED].join('\n'));
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

  // ── The skill, for agents without skills ──────────────────────────────────

  const skillFiles = () => templateFiles();
  for (const f of skillFiles()) {
    server.registerResource(
      `${SKILL_NAME}/${f.path}`,
      `snitch://skill/${SKILL_NAME}/${f.path}`,
      { title: f.path === 'SKILL.md' ? 'The snitch-fix skill' : `snitch-fix: ${f.path}`, mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: fillTemplate(f.text, await skillValues()) }] }),
    );
  }

  /** What the skill's placeholders become here: the server, the ticket prefix when clear, and the project in cwd. */
  const skillValues = async () => {
    const values: Parameters<typeof fillTemplate>[1] = detectProject(opts.cwd ?? process.cwd());
    try {
      const client = await getClient();
      values.server = client.server;
      const projects = await client.projects();
      if (projects.length === 1) values.prefix = projects[0]!.ticketPrefix;
    } catch {
      // Signed out: placeholders, and step 0 of the skill says how to sign in.
    }
    return values;
  };

  const skillPrompt = async (task: string): Promise<GetPromptResult> => {
    const values = await skillValues();
    const [main, ...refs] = skillFiles();
    const body = fillTemplate(main!.text, values).replace(/^---\n[\s\S]*?\n---\n/, '');
    const note = refs.length ? `\nThe files it links are MCP resources of this server: ${refs.map((r) => `snitch://skill/${SKILL_NAME}/${r.path}`).join(', ')}.` : '';
    return {
      description: 'The snitch-fix workflow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `${task}\n\nFollow the workflow below. If this repository has its own copy (.claude/skills/${SKILL_NAME}/SKILL.md, or a Snitch section in AGENTS.md), follow that instead: it knows the project.${note}\n\n${body}`,
          },
        },
      ],
    };
  };

  server.registerPrompt(
    'fix_reports',
    {
      title: 'Fix Snitch reports',
      description: 'Reports in, pull requests out: gather the evidence, reproduce, fix test-first, open one pull request per report.',
      argsSchema: { reports: z.string().optional().describe('Ticket keys or issue numbers, or "all"; empty to list the open ones and choose') },
    },
    async ({ reports }) => skillPrompt(reports?.trim() ? `Work on these Snitch reports: ${reports.trim()}.` : 'List the open Snitch reports and ask me which to take.'),
  );

  server.registerPrompt(
    'triage_reports',
    {
      title: 'Triage Snitch reports',
      description: 'Gather and diagnose every open report, find duplicates and reports already fixed, and report back without changing code.',
    },
    async () => skillPrompt('Triage the open Snitch reports (the `triage` argument): gather and diagnose each one, but report back instead of fixing.'),
  );

  if (opts.readOnly) return server;

  // ── Changing tickets ──────────────────────────────────────────────────────

  server.registerTool(
    'comment_on_ticket',
    {
      title: 'Comment on a Snitch ticket',
      description: 'Adds a comment as the signed-in user (it also reaches the linked GitHub issue when comment sync is on). Needs the tickets:write scope.',
      inputSchema: { ticket: ticketArg, body: z.string().min(1).max(10_000) },
      annotations: { ...WRITE, idempotentHint: false },
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
        'Moves a ticket: new, triaged, in_progress, resolved, wont_fix or duplicate (prefer mark_duplicate, which says of what). Resolving can email the tester and close the linked issue: leave it to a person unless asked. Prefer in_progress when a fix is only proposed. Needs the tickets:write scope.',
      inputSchema: {
        ticket: ticketArg,
        status: z.enum(TICKET_STATUSES),
        fixed_in: z.string().min(1).max(64).optional().describe('With resolved: the build the fix ships in (list_builds)'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    withClient(async (client, a: { ticket: string; status: (typeof TICKET_STATUSES)[number]; fixed_in?: string }) => {
      const detail = await client.ticket(a.ticket);
      await client.update(detail.ticket.id, { status: a.status, ...(a.fixed_in ? { fixedIn: a.fixed_in } : {}) });
      return text(`${detail.ticket.key}: ${detail.ticket.status} → ${a.status}${a.fixed_in ? `, fixed in ${a.fixed_in}` : ''}.`);
    }),
  );

  server.registerTool(
    'assign_ticket',
    {
      title: 'Assign a Snitch ticket',
      description: 'Gives a ticket to someone ("me", a teammate’s email or name) or to nobody. Assigning someone else may email them. Needs the tickets:write scope.',
      inputSchema: { ticket: ticketArg, to: z.string().describe('"me", "nobody", or an email or name') },
      annotations: { ...WRITE, idempotentHint: true },
    },
    withClient(async (client, a: { ticket: string; to: string }) => {
      const detail = await client.ticket(a.ticket);
      const who = await personId(client, a.to);
      await client.update(detail.ticket.id, { assigneeUserId: who.id });
      return text(`${detail.ticket.key} is assigned to ${who.label}.`);
    }),
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Retitle or retype a Snitch ticket',
      description: 'Gives a ticket a plainer title, or the right report type (a bug filed as an idea). Needs the tickets:write scope.',
      inputSchema: {
        ticket: ticketArg,
        title: z.string().min(1).max(200).optional(),
        type: z.string().optional().describe('A report type id of the ticket’s project, e.g. bug'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    withClient(async (client, a: { ticket: string; title?: string; type?: string }) => {
      if (!a.title && !a.type) return failure('Nothing to change: pass a title, a type, or both.');
      const detail = await client.ticket(a.ticket);
      if (a.type && !detail.project.reportTypes.some((r) => r.id === a.type)) return failure(`No report type ${a.type} in ${detail.project.name}. Types: ${detail.project.reportTypes.map((r) => r.id).join(', ')}`);
      await client.update(detail.ticket.id, { ...(a.title ? { title: a.title.trim() } : {}), ...(a.type ? { type: a.type } : {}) });
      return text(`${detail.ticket.key} updated${a.title ? `: “${a.title.trim()}”` : ''}${a.type ? ` (type ${a.type})` : ''}.`);
    }),
  );

  server.registerTool(
    'mark_duplicate',
    {
      title: 'Mark a Snitch ticket a duplicate',
      description: 'Marks a ticket as a duplicate of another in the same project (status duplicate, linked to the original). Mark the newer one. Needs the tickets:write scope.',
      inputSchema: { ticket: ticketArg, of: z.string().min(1).describe('The original ticket: key, id or link') },
      annotations: { ...WRITE, idempotentHint: true },
    },
    withClient(async (client, a: { ticket: string; of: string }) => {
      const [detail, original] = await Promise.all([client.ticket(a.ticket), client.ticket(a.of)]);
      await client.update(detail.ticket.id, { duplicateOfId: original.ticket.id });
      return text(`${detail.ticket.key} is now a duplicate of ${original.ticket.key}.`);
    }),
  );

  server.registerTool(
    'escalate_ticket',
    {
      title: 'Open a Snitch ticket in an integration',
      description:
        'Sends a ticket to one of its project’s integrations, as the dashboard’s button does: opens a GitHub issue (with the media, as the integration is set up), sends an email or calls a webhook. Without `integration`, it uses the one routing suggests, or the only one there is. Visible to everyone who can see the issue tracker. Needs the tickets:write scope.',
      inputSchema: { ticket: ticketArg, integration: z.string().optional().describe('Integration name or id') },
      annotations: { ...WRITE, idempotentHint: false },
    },
    withClient(async (client, a: { ticket: string; integration?: string }) => {
      const detail = await client.ticket(a.ticket);
      const all = detail.project.integrations;
      if (!all) return failure(`${client.server} doesn't list integrations to API tokens; it may be older than this snitch-cli. Escalate from the dashboard.`);
      const usable = all.filter((i) => i.enabled);
      const done = new Map(detail.escalations.filter((e) => e.state !== 'failed').map((e) => [e.integrationId, e]));
      const names = usable.map((i) => `${i.name} (${i.kind})`).join(', ') || 'none';
      const only = <T,>(xs: T[]) => (xs.length === 1 ? xs[0] : undefined);
      const wanted = a.integration?.toLowerCase();
      const target = wanted
        ? usable.find((i) => i.id.toLowerCase() === wanted || i.name.toLowerCase() === wanted)
        : (only(usable.filter((i) => detail.suggestedIntegrationIds.includes(i.id))) ?? only(usable.filter((i) => !done.has(i.id))));
      if (!target) return failure(a.integration ? `No enabled integration "${a.integration}". Integrations: ${names}` : `Which integration? ${names}`);
      const already = done.get(target.id);
      if (already) return text(`${detail.ticket.key} is already in ${target.name}${already.externalUrl ? `: ${already.externalUrl}` : ` (${already.state})`}.`);
      await client.escalate(detail.ticket.id, target.id);
      return text(`Queued: Snitch is sending ${detail.ticket.key} to ${target.name}. get_ticket shows the link once it's there.`);
    }),
  );

  return server;
}

export async function runMcp(getClient: ClientProvider, opts: McpOptions = {}): Promise<void> {
  await buildMcpServer(getClient, opts).connect(new StdioServerTransport());
}
