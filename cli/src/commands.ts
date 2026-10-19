/**
 * The snitch commands. index.ts runs them against the real process; tests run
 * them with their own output, environment and clock (Io).
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { API_TOKEN, TICKET_STATUSES, type ApiTokenScope, type TicketListQuery, type TicketStatus } from '@snitch/contract';
import { SnitchClient, SnitchError } from './client';
import { Credentials, normalizeServer } from './credentials';
import { collectEvidence, defaultDir, ticketSummary } from './evidence';
import { runMcp } from './mcp';
import { detectProject, fillTemplate, installSkill, joinSkill, templateFiles } from './skill';
import { VERSION } from './version';

export const HELP = `snitch ${VERSION}: Snitch QA tickets from the terminal, and an MCP server for coding agents

Usage
  snitch login [--server URL]          sign in through the dashboard (opens your browser)
      --read-only                      only ask to read tickets
      --days N | --days never          how long the token lasts (default 90)
      --no-browser                     print the link instead of opening it
      --with-token                     paste a token made on the API tokens page instead
  snitch logout [--keep-token]         sign out and revoke the token
  snitch whoami

  snitch tickets [--status open|all|new|triaged|in_progress|resolved|wont_fix|duplicate]
                 [--type bug] [--project slug] [--search words] [--limit 25] [--json]
  snitch ticket <KEY|id|link> [--json]
  snitch ticket <KEY|id|link> --download [--out DIR] [--no-frames]
                                       save screenshot, video, frames, timeline, logs and report.md
  snitch comment <KEY|id|link> <text…>  (or the text on stdin)
  snitch status <KEY|id|link> <status> [--fixed-in BUILD]

  snitch skill install [--dir DIR] [--project slug] [--force]
                                       add the snitch-fix agent skill to a project (.claude/skills/), filled in
                                       with your server, ticket prefix, branch and checks: reports in, pull
                                       requests out
  snitch skill print [--dir DIR]       print it as one file instead, for other agents (AGENTS.md)

  snitch mcp [--read-only]             run the MCP server on stdio (for Claude Code, Cursor, …);
                                       --read-only leaves out the tools that change tickets

Everywhere: --server URL, or SNITCH_URL. SNITCH_TOKEN skips the stored token (for CI).
Docs: https://github.com/monjar/mobile-app-qa-sdk/blob/master/docs/cli.md`;

export class UsageError extends Error {}

/** Everything a command touches outside itself. */
export interface Io {
  out: (s?: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  /** Piped input (a token for --with-token, a comment); null when stdin is a terminal. */
  stdin: () => Promise<string | null>;
  /** Whether to open the browser for `login`. */
  interactive: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export const processIo: Io = {
  out: (s = '') => void process.stdout.write(`${s}\n`),
  err: (s) => void process.stderr.write(`${s}\n`),
  env: process.env,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  stdin: async () => (process.stdin.isTTY ? null : readStdin()),
  interactive: Boolean(process.stdout.isTTY),
};

/** Reads a line without echoing it (a pasted token), or all of stdin when it isn't a terminal. */
async function readSecret(io: Io, prompt: string): Promise<string> {
  const piped = await io.stdin();
  if (piped !== null) return piped.trim();
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          done();
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          done();
          return reject(new UsageError('Cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };
    process.stdin.on('data', onData);
  });
}

/** Text from a server, made safe to print: no control characters (terminal escape sequences). */
export const printable = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/**
 * Opens `url` in the default browser. No shell is involved anywhere, so a URL can't smuggle in a command
 * (on Windows `cmd /c start` would interpret `&`, `|` and `^`).
 */
function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false }).on('error', () => undefined).unref();
  } catch {
    // The link is printed anyway.
  }
}

/** The approval link the server sent, if it's an http(s) page on that same server; null otherwise. */
export function trustedLink(link: string, server: string): string | null {
  try {
    const u = new URL(link);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === server ? u.toString() : null;
  } catch {
    return null;
  }
}

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/;

export async function signedIn(creds: Credentials, serverFlag?: string): Promise<SnitchClient> {
  const server = creds.server(serverFlag);
  if (!server) throw new UsageError('No Snitch server yet. Run `snitch login --server https://your-snitch-server` first, or set SNITCH_URL.');
  const t = await creds.token(server);
  if (!t) throw new UsageError(`Not signed in to ${server}. Run \`snitch login --server ${server}\`, or set SNITCH_TOKEN.`);
  return new SnitchClient(server, t.token);
}

const where = (kind: string) => (kind === 'keyring' ? "your system's credential store" : kind === 'file' ? 'a file only you can read (no credential store here)' : kind);

async function login(io: Io, creds: Credentials, v: Record<string, unknown>): Promise<void> {
  const { out, err } = io;
  const flag = v.server as string | undefined;
  const server = flag ? normalizeServer(flag) : creds.server();
  if (!server) throw new UsageError('Which Snitch server? Run `snitch login --server https://your-snitch-server`.');
  const url = new URL(server);
  if (url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) {
    err(`Warning: ${server} is plain http, so the sign-in code and the token travel unencrypted. Use https unless this is a network you trust.`);
  }

  if (v['with-token']) {
    const token = await readSecret(io, `Paste an API token for ${server}: `);
    if (!API_TOKEN.test(token)) throw new UsageError('That isn’t a Snitch API token (they start with snitch_at_).');
    const me = await new SnitchClient(server, token).whoami();
    const kind = await creds.save(server, token);
    creds.setDefaultServer(server);
    out(`Signed in to ${server} as ${me.user.email}. The token is in ${where(kind)}.`);
    return;
  }

  const days = v.days === undefined ? undefined : v.days === 'never' ? null : Number(v.days);
  if (days !== undefined && days !== null && !(Number.isInteger(days) && days >= 1 && days <= 366)) throw new UsageError('--days takes 1 to 366, or never');
  const scopes: ApiTokenScope[] = v['read-only'] ? ['tickets:read'] : ['tickets:read', 'tickets:write'];
  const client = new SnitchClient(server, null);
  const d = await client.startDevice({ clientName: `snitch CLI on ${hostname().replace(/\.local$/, '')}`.slice(0, 80), scopes, ...(days !== undefined ? { expiresInDays: days } : {}) });
  // The server says where to approve; only follow it to a page on that same server.
  const link = trustedLink(d.verificationUrlComplete, server) ?? `${server}/device?code=${encodeURIComponent(d.userCode)}`;
  err(`\nYour code: ${printable(d.userCode)}\n\nApprove it at ${printable(link)}`);
  if (!v['no-browser'] && io.interactive) {
    openBrowser(link);
    err('(opened in your browser)');
  }
  err('Waiting for approval…');
  let interval = d.interval;
  // Count waited time rather than reading the clock, so a test's instant sleep works too.
  for (let waited = 0; waited < d.expiresIn; waited += interval) {
    await io.sleep(interval * 1000);
    let r;
    try {
      r = await client.pollDevice(d.deviceCode);
    } catch (e) {
      // A dropped connection, a restart or a 429 shouldn't throw away a sign-in that's waiting for approval.
      if (e instanceof SnitchError && (e.status === 0 || e.status === 429 || e.status >= 500)) continue;
      throw e;
    }
    if (r.status !== 'approved') {
      if (r.status === 'denied') throw new UsageError('The sign-in was denied.');
      if (r.status === 'expired') break;
      if (r.status === 'slow_down') interval += 5;
      continue;
    }
    const kind = await creds.save(server, r.token);
    creds.setDefaultServer(server);
    out(`Signed in to ${server} as ${r.user.email}. The token “${r.view.name}” is in ${where(kind)}${r.view.expiresAt ? ` and lasts until ${new Date(r.view.expiresAt).toLocaleDateString()}` : ''}.`);
    return;
  }
  throw new UsageError('The code expired before it was approved. Run `snitch login` again.');
}

const age = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export async function run(argv: string[], io: Io = processIo): Promise<void> {
  const { out } = io;
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      'read-only': { type: 'boolean' },
      days: { type: 'string' },
      'no-browser': { type: 'boolean' },
      'with-token': { type: 'boolean' },
      'keep-token': { type: 'boolean' },
      status: { type: 'string' },
      type: { type: 'string' },
      project: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string' },
      download: { type: 'boolean' },
      out: { type: 'string' },
      'no-frames': { type: 'boolean' },
      'fixed-in': { type: 'string' },
      dir: { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  const [cmd, ...args] = positionals;
  if (v.version) return out(VERSION);
  if (v.help || !cmd || cmd === 'help') return out(HELP);
  const creds = new Credentials(io.env);

  switch (cmd) {
    case 'login':
      return login(io, creds, v);

    case 'logout': {
      const server = creds.server(v.server);
      if (!server) return out('Not signed in.');
      const t = await creds.token(server);
      let stillLive = Boolean(v['keep-token']);
      if (t && t.from !== 'env' && !v['keep-token']) {
        try {
          await new SnitchClient(server, t.token).revokeSelf();
        } catch (e) {
          // 401: it was already revoked or expired. Anything else: forget it here anyway, and say so.
          if (!(e instanceof SnitchError && e.status === 401)) {
            stillLive = true;
            io.err(`Couldn't revoke the token on the server (${e instanceof Error ? e.message : String(e)}).`);
          }
        }
      }
      await creds.remove(server);
      return out(`Signed out of ${server}${stillLive ? ' (the token still works; revoke it on the API tokens page)' : ''}.`);
    }

    case 'whoami': {
      const client = await signedIn(creds, v.server);
      const me = await client.whoami();
      if (v.json) return out(JSON.stringify(me, null, 2));
      return out(
        `${me.user.email} (${me.user.role}) on ${client.server}, Snitch ${me.server.version}${me.token ? `\nToken “${me.token.name}”: ${me.token.scopes.join(', ')}${me.token.expiresAt ? `, until ${new Date(me.token.expiresAt).toLocaleDateString()}` : ', never expires'}` : ''}`,
      );
    }

    case 'tickets': {
      const client = await signedIn(creds, v.server);
      const status = (v.status ?? 'open') as TicketListQuery['status'];
      const q: TicketListQuery = { status, limit: v.limit ? Number(v.limit) : 25, ...(v.type ? { type: v.type } : {}), ...(v.search ? { q: v.search } : {}) };
      if (v.project) {
        const p = (await client.projects()).find((x) => x.slug === v.project || x.id === v.project);
        if (!p) throw new UsageError(`No project ${v.project}`);
        q.projectId = p.id;
      }
      const list = await client.tickets(q);
      if (v.json) return out(JSON.stringify(list, null, 2));
      if (!list.items.length) return out('No tickets.');
      const w = Math.max(...list.items.map((t) => t.key.length));
      for (const t of list.items) out(`${t.key.padEnd(w)}  ${t.status.padEnd(11)} ${t.type.padEnd(8)} ${age(t.createdAt).padStart(4)}  ${t.title}`);
      if (list.nextCursor) out(`… more (--limit up to 100, or narrow with --search)`);
      return;
    }

    case 'ticket': {
      const ref = args[0];
      if (!ref) throw new UsageError('Which ticket? `snitch ticket APP-12`');
      const client = await signedIn(creds, v.server);
      const detail = await client.ticket(ref);
      if (!v.download) return out(v.json ? JSON.stringify(detail, null, 2) : ticketSummary(detail, client.server));
      const dir = v.out ? join(v.out, detail.ticket.key) : defaultDir(client.server, detail.ticket.key, io.env);
      const ev = await collectEvidence(client, detail, dir, { frames: !v['no-frames'] });
      if (v.json) return out(JSON.stringify(ev, null, 2));
      out(`${detail.ticket.key} saved to ${ev.dir}`);
      out(`  report.md  ${ev.report}`);
      for (const [name, path] of Object.entries(ev.files)) out(`  ${name.padEnd(9)}  ${path}`);
      if (ev.frames.length) out(`  frames     ${ev.frames.length} (one per second) and ${ev.sheets.length} contact sheet${ev.sheets.length === 1 ? '' : 's'}`);
      for (const n of ev.notes) out(`  note: ${n}`);
      return;
    }

    case 'comment': {
      const [ref, ...words] = args;
      if (!ref) throw new UsageError('Usage: snitch comment <ticket> <text…>');
      const body = words.length ? words.join(' ') : ((await io.stdin()) ?? '').trim();
      if (!body) throw new UsageError('Nothing to say: pass the text, or pipe it in.');
      const client = await signedIn(creds, v.server);
      const detail = await client.ticket(ref);
      await client.comment(detail.ticket.id, body);
      return out(`Commented on ${detail.ticket.key}.`);
    }

    case 'status': {
      const [ref, status] = args;
      if (!ref || !status || !(TICKET_STATUSES as readonly string[]).includes(status)) throw new UsageError(`Usage: snitch status <ticket> <${TICKET_STATUSES.join('|')}>`);
      const client = await signedIn(creds, v.server);
      const detail = await client.ticket(ref);
      await client.update(detail.ticket.id, { status: status as TicketStatus, ...(v['fixed-in'] ? { fixedIn: v['fixed-in'] } : {}) });
      return out(`${detail.ticket.key}: ${detail.ticket.status} → ${status}`);
    }

    case 'skill': {
      const sub = args[0];
      if (sub !== 'install' && sub !== 'print') throw new UsageError('Usage: snitch skill install [--dir DIR] [--project slug] [--force] | snitch skill print');
      // Fill in what we know: the server, and the ticket prefix when it's clear which project.
      const server = creds.server(v.server);
      let prefix: string | null = null;
      const notes: string[] = [];
      if (server && (await creds.token(server))) {
        try {
          const projects = await (await signedIn(creds, v.server)).projects();
          const chosen = v.project ? projects.find((p) => p.slug === v.project || p.id === v.project) : projects.length === 1 ? projects[0] : undefined;
          if (chosen) prefix = chosen.ticketPrefix;
          else if (v.project) throw new UsageError(`No project ${v.project} on ${server}`);
          else notes.push(`${projects.length} projects on ${server}: pass --project <slug> to fill in the ticket prefix.`);
        } catch (e) {
          if (e instanceof UsageError) throw e;
          notes.push(`Couldn't read projects from ${server} (${e instanceof Error ? e.message : String(e)}); the ticket prefix is a placeholder.`);
        }
      } else notes.push('Not signed in, so the server and ticket prefix are placeholders. Run `snitch login` first to fill them in.');
      const dir = v.dir ?? process.cwd();
      const values = { server, prefix, ...detectProject(dir) };
      const files = templateFiles().map((f) => ({ ...f, text: fillTemplate(f.text, values) }));
      if (sub === 'print') {
        out(joinSkill(files));
        for (const n of notes) io.err(n);
        return;
      }
      const paths = installSkill(dir, files, Boolean(v.force));
      out(`Wrote ${paths[0]}`);
      for (const p of paths.slice(1)) out(`  and ${p}`);
      for (const n of notes) out(`  note: ${n}`);
      out(`Next: check the "This project" tables in it (how to run the app, other repositories a fix may touch), then ask your agent to "fix the Snitch reports".`);
      out(`For Claude Code, the snitch MCP server makes reports visible as images: claude mcp add snitch -- npx -y snitch-cli mcp`);
      return;
    }

    case 'mcp': {
      // Resolved per call, so signing in while the agent runs takes effect without a restart.
      const serverFlag = v.server;
      return runMcp(() => signedIn(new Credentials(io.env), serverFlag), { env: io.env, readOnly: Boolean(v['read-only']) });
    }

    default:
      throw new UsageError(`Unknown command ${cmd}. Try \`snitch --help\`.`);
  }
}
