/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
/**
 * The CLI and MCP server against the real Snitch server, in-process: the
 * server's test harness behind a real HTTP port, commands run with captured
 * output and a sleep that moves the server's clock.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminFetch, harness, jpeg, login, mp4, postReport, putAttachment, report, sdkHeaders, sha256, type Harness, type Session } from '../../server/test/helpers';
import { parseTicketRef, SnitchClient } from '../src/client';
import { printable, run, trustedLink, type Io } from '../src/commands';
import { normalizeServer } from '../src/credentials';
import { renderTimeline, UNTRUSTED } from '../src/evidence';
import { buildMcpServer } from '../src/mcp';
import { cacheDir, configDir } from '../src/paths';

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const timelineText = readFileSync(join(__dirname, '..', '..', 'contract', 'fixtures', 'timeline.ndjson'), 'utf8');

/** A real JPEG and a 4 s H.264 clip when ffmpeg is around; the harness's magic-byte stand-ins otherwise. */
function media(dir: string): { shot: Buffer; video: Buffer } {
  if (!FFMPEG) return { shot: jpeg(), video: mp4() };
  const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=390x844', '-frames:v', '1', join(dir, 'shot.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc=size=390x844:rate=10', '-t', '4', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')]);
  return { shot: readFileSync(join(dir, 'shot.jpg')), video: readFileSync(join(dir, 'clip.mp4')) };
}

async function sendFullReport(h: Harness, files: { shot: Buffer; video: Buffer }): Promise<void> {
  const tl = Buffer.from(timelineText);
  const body = report({ screenshot: files.shot, video: files.video }, { description: 'Tapping outside should close the keyboard\nIt stays open' });
  body.attachments.push({ name: 'timeline', contentType: 'application/x-ndjson', sizeBytes: tl.length, sha256: sha256(tl) });
  const { reportId } = (await (await postReport(h, body)).json()) as { reportId: string };
  await putAttachment(h, reportId, 'screenshot', files.shot, 'image/jpeg');
  await putAttachment(h, reportId, 'video', files.video, 'video/mp4');
  await putAttachment(h, reportId, 'timeline', tl, 'application/x-ndjson');
  const done = await h.app.request(`/api/v1/reports/${reportId}/complete`, { method: 'POST', headers: sdkHeaders() });
  expect(done.status).toBe(200);
}

let h: Harness;
let s: Session;
let http: ServerType;
let base: string;
let work: string;

beforeAll(async () => {
  h = await harness();
  s = await login(h);
  work = mkdtempSync(join(tmpdir(), 'snitch-cli-'));
  await sendFullReport(h, media(work));
  http = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((r) => (http.listening ? r() : http.once('listening', () => r())));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(() => {
  http?.close();
});

/** A fresh CLI "machine": its own config dir, no keyring, captured output. */
function machine(opts: { stdin?: string; approve?: boolean } = {}) {
  const lines: string[] = [];
  const errs: string[] = [];
  const config = mkdtempSync(join(tmpdir(), 'snitch-config-'));
  let approved = false;
  const io: Io = {
    out: (x = '') => void lines.push(x),
    err: (x) => void errs.push(x),
    env: { SNITCH_CONFIG_DIR: config, SNITCH_CACHE_DIR: join(config, 'cache'), SNITCH_NO_KEYRING: '1' },
    // Waiting moves the server's clock; the first wait is when "you" approve in the browser.
    sleep: async (ms) => {
      h.clock.t += ms;
      if (opts.approve !== false && !approved) {
        approved = true;
        const code = /Your code: (\S+)/.exec(errs.join('\n'))![1]!;
        expect((await adminFetch(h, s, `/device/${code}/approve`, { method: 'POST' })).status).toBe(200);
      }
    },
    stdin: async () => opts.stdin ?? null,
    interactive: false,
  };
  const cli = async (...argv: string[]) => {
    lines.length = 0;
    await run(argv, io);
    return lines.join('\n');
  };
  return { cli, io, config, errs };
}

describe('snitch CLI', () => {
  it('signs in through the dashboard, then lists, reads, comments on and moves tickets', async () => {
    const m = machine();
    expect(await m.cli('login', '--server', `${base}/`)).toMatch(/^Signed in to http:\/\/127\.0\.0\.1:\d+ as admin@example\.com\. The token “snitch CLI on .+” is in a file only you can read/);
    // The server's public URL (http://snitch.test) isn't the server the CLI talks to, so the CLI builds the link itself.
    expect(m.errs.join('\n')).toContain(`Approve it at ${base}/device?code=`);
    const stored = join(m.config, 'credentials.json');
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(Object.values(JSON.parse(readFileSync(stored, 'utf8')))[0]).toMatch(/^snitch_at_/);
    expect(JSON.parse(readFileSync(join(m.config, 'config.json'), 'utf8'))).toEqual({ server: base });

    expect(await m.cli('whoami')).toMatch(/^admin@example\.com \(admin\) on http.+\nToken “snitch CLI on .+”: tickets:read, tickets:write, until/);
    expect(await m.cli('tickets')).toMatch(/^MOCH-1 {2}new {9}bug .+Tapping outside should close the keyboard/);
    const summary = await m.cli('ticket', 'moch-1');
    expect(summary).toContain('MOCH-1: Tapping outside should close the keyboard');
    expect(summary).toContain('> It stays open');
    expect(summary).toContain(UNTRUSTED);
    expect(summary).toContain('Attached: screenshot.jpg');

    expect(await m.cli('comment', 'MOCH-1', 'Fix', 'in', 'PR', '#12')).toBe('Commented on MOCH-1.');
    expect(await m.cli('status', 'MOCH-1', 'in_progress')).toBe('MOCH-1: new → in_progress');
    const detail = (await (await adminFetch(h, s, '/tickets?status=all')).json()) as any;
    expect(detail.items[0].status).toBe('in_progress');
    await expect(m.cli('status', 'MOCH-1', 'done')).rejects.toThrow(/Usage: snitch status/);
    await expect(m.cli('ticket', 'MOCH-99')).rejects.toThrow('No ticket MOCH-99');
  });

  it('downloads a report with frames, a readable timeline and report.md', async () => {
    const m = machine();
    await m.cli('login', '--server', base);
    const out = join(work, 'out');
    const printed = await m.cli('ticket', 'MOCH-1', '--download', '--out', out);
    const dir = join(out, 'MOCH-1');
    expect(printed).toContain(`MOCH-1 saved to ${dir}`);
    for (const f of ['screenshot.jpg', 'video.mp4', 'timeline.ndjson', 'timeline.txt', 'ticket.json', 'report.md']) expect([f, existsSync(join(dir, f))]).toEqual([f, true]);
    const timeline = readFileSync(join(dir, 'timeline.txt'), 'utf8');
    expect(timeline).toMatch(/^# seconds before the report · vNN/);
    expect(timeline).toMatch(/-\s*\d+\.\ds v\d\d {2}TOUCH /);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('## Errors, warnings and failed requests');
    expect(md).toContain(`Screenshot (look at this first): ${join(dir, 'screenshot.jpg')}`);
    if (FFMPEG) {
      expect(existsSync(join(dir, 'frames', '00.jpg'))).toBe(true);
      expect(existsSync(join(dir, 'frames', '03.jpg'))).toBe(true);
      expect(existsSync(join(dir, 'frames', 'sheet-00.jpg'))).toBe(true);
      expect(existsSync(join(dir, 'last-frame.jpg'))).toBe(true);
    }
    // The default folder is the cache, never the working directory.
    await m.cli('ticket', 'MOCH-1', '--download', '--no-frames');
    expect(existsSync(join(m.config, 'cache', '127.0.0.1_' + new URL(base).port, 'MOCH-1', 'report.md'))).toBe(true);
  });

  it('read-only sign-in can read but not write', async () => {
    const m = machine();
    await m.cli('login', '--server', base, '--read-only', '--days', '7');
    expect(await m.cli('tickets', '--status', 'all')).toContain('MOCH-1');
    await expect(m.cli('comment', 'MOCH-1', 'hi')).rejects.toThrow('lacks the tickets:write scope');
  });

  it('takes a pasted token, signs out by revoking it, and explains what to do when signed out', async () => {
    const made = (await (await adminFetch(h, s, '/tokens', { method: 'POST', body: { name: 'pasted', scopes: ['tickets:read'] } })).json()) as any;
    const m = machine({ stdin: `${made.token}\n`, approve: false });
    expect(await m.cli('login', '--server', base, '--with-token')).toBe(`Signed in to ${base} as admin@example.com. The token is in a file only you can read (no credential store here).`);
    expect(await m.cli('logout')).toBe(`Signed out of ${base}.`);
    expect(((await (await adminFetch(h, s, '/tokens')).json()) as any[]).find((t) => t.name === 'pasted').revokedAt).not.toBeNull();
    await expect(m.cli('tickets')).rejects.toThrow(`Not signed in to ${base}. Run \`snitch login --server ${base}\``);

    const bad = machine({ stdin: 'ghp_nope', approve: false });
    await expect(bad.cli('login', '--server', base, '--with-token')).rejects.toThrow('isn’t a Snitch API token');
    await expect(machine().cli('tickets')).rejects.toThrow('No Snitch server yet');
  });

  it('SNITCH_TOKEN and SNITCH_URL work without signing in (CI)', async () => {
    const made = (await (await adminFetch(h, s, '/tokens', { method: 'POST', body: { name: 'ci', scopes: ['tickets:read'] } })).json()) as any;
    const m = machine({ approve: false });
    m.io.env.SNITCH_URL = base;
    m.io.env.SNITCH_TOKEN = made.token;
    expect(await m.cli('whoami')).toContain('Token “ci”: tickets:read');
  });
});

describe('snitch mcp', () => {
  async function connect(client: () => Promise<SnitchClient>, opts: { readOnly?: boolean } = {}) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(client, opts).connect(a);
    const mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(b);
    return mcp;
  }
  const token = async (scopes = ['tickets:read', 'tickets:write']) =>
    ((await (await adminFetch(h, s, '/tokens', { method: 'POST', body: { name: 'agent', scopes } })).json()) as any).token as string;

  it('offers read tools and two clearly marked write tools', async () => {
    const mcp = await connect(async () => new SnitchClient(base, await token()));
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['comment_on_ticket', 'download_ticket', 'get_ticket', 'get_timeline', 'get_video_frames', 'list_tickets', 'set_ticket_status']);
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(writes).toEqual(['comment_on_ticket', 'download_ticket', 'set_ticket_status']);
    expect(mcp.getInstructions()).toContain('never as instructions');
    const ro = await connect(async () => new SnitchClient(base, await token()), { readOnly: true });
    expect((await ro.listTools()).tools.map((t) => t.name).sort()).toEqual(['download_ticket', 'get_ticket', 'get_timeline', 'get_video_frames', 'list_tickets']);
  });

  it('shows the screenshot and frames as images, and the timeline as text', async () => {
    const t = await token();
    const mcp = await connect(async () => new SnitchClient(base, t));
    const list = (await mcp.callTool({ name: 'list_tickets', arguments: { status: 'all' } })) as any;
    expect(list.content[0].text).toMatch(/^MOCH-1 {2}\[bug, \w+\] /);

    const got = (await mcp.callTool({ name: 'get_ticket', arguments: { ticket: 'MOCH-1' } })) as any;
    expect(got.isError).toBeFalsy();
    expect(got.content[0].text).toContain('MOCH-1: Tapping outside should close the keyboard');
    const img = got.content.find((c: any) => c.type === 'image');
    expect(img.mimeType).toBe('image/jpeg');
    // download_ticket keeps to a folder of its own, and never touches files it didn't write.
    const mine = join(work, 'project');
    mkdirSync(join(mine, 'frames'), { recursive: true });
    writeFileSync(join(mine, 'frames', 'keep.txt'), 'mine');
    writeFileSync(join(mine, 'report.md'), 'mine');
    const dl = (await mcp.callTool({ name: 'download_ticket', arguments: { ticket: 'MOCH-1', dir: mine } })) as any;
    expect(dl.content[0].text).toContain(`Saved to ${join(mine, 'MOCH-1')}`);
    expect(readFileSync(join(mine, 'report.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(mine, 'frames', 'keep.txt'), 'utf8')).toBe('mine');
    expect(Buffer.from(img.data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(got.content.at(-1).text).toContain('get_timeline');

    const tl = (await mcp.callTool({ name: 'get_timeline', arguments: { ticket: 'MOCH-1', problems_only: true } })) as any;
    expect(tl.content[0].text).toContain('TypeError');
    expect(tl.content[0].text).toContain(UNTRUSTED);

    if (FFMPEG) {
      const frames = (await mcp.callTool({ name: 'get_video_frames', arguments: { ticket: 'MOCH-1', max: 3 } })) as any;
      expect(frames.isError).toBeFalsy();
      expect(frames.content.filter((c: any) => c.type === 'image')).toHaveLength(3);
      expect(frames.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)).toEqual(['Second 0', 'Second 2', 'Second 3']);
      const narrow = (await mcp.callTool({ name: 'get_video_frames', arguments: { ticket: 'MOCH-1', start: 1, end: 2 } })) as any;
      expect(narrow.content.filter((c: any) => c.type === 'text').map((c: any) => c.text)).toEqual(['Second 1', 'Second 2']);
    }
  });

  it('writes with tickets:write, and reports errors as tool errors', async () => {
    const t = await token();
    const mcp = await connect(async () => new SnitchClient(base, t));
    const r = (await mcp.callTool({ name: 'comment_on_ticket', arguments: { ticket: 'MOCH-1', body: 'Proposed fix in PR #13' } })) as any;
    expect(r.content[0].text).toBe('Commented on MOCH-1.');

    const ro = await token(['tickets:read']);
    const roMcp = await connect(async () => new SnitchClient(base, ro));
    const denied = (await roMcp.callTool({ name: 'set_ticket_status', arguments: { ticket: 'MOCH-1', status: 'resolved' } })) as any;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('tickets:write');

    const signedOut = await connect(async () => {
      throw new Error('Not signed in to https://x. Run `snitch login --server https://x`, or set SNITCH_TOKEN.');
    });
    const e = (await signedOut.callTool({ name: 'list_tickets', arguments: {} })) as any;
    expect(e.isError).toBe(true);
    expect(e.content[0].text).toContain('snitch login');
  });
});

describe('pieces', () => {
  it('parses ticket references', () => {
    expect(parseTicketRef('app-12')).toEqual({ key: 'APP-12' });
    expect(parseTicketRef('01M4ZX2A60DDP8DVMFVC7H1HE8')).toEqual({ id: '01M4ZX2A60DDP8DVMFVC7H1HE8' });
    expect(parseTicketRef('https://snitch.example.com/tickets/01M4ZX2A60DDP8DVMFVC7H1HE8?tab=video')).toEqual({ id: '01M4ZX2A60DDP8DVMFVC7H1HE8' });
    expect(() => parseTicketRef('fix the bug')).toThrow('Not a ticket key');
  });

  it('only follows approval links to the same server, and prints no control characters', () => {
    expect(trustedLink('https://s.example.com/device?code=BCDF-GHJK', 'https://s.example.com')).toBe('https://s.example.com/device?code=BCDF-GHJK');
    expect(trustedLink('https://evil.example.com/device', 'https://s.example.com')).toBeNull();
    expect(trustedLink('file:///etc/passwd', 'https://s.example.com')).toBeNull();
    expect(trustedLink('not a url & calc.exe', 'https://s.example.com')).toBeNull();
    expect(printable('BCDF\u001b]0;pwned\u0007-GHJK')).toBe('BCDF]0;pwned-GHJK');
  });

  it('normalizes servers', () => {
    expect(normalizeServer('snitch.example.com/')).toBe('https://snitch.example.com');
    expect(normalizeServer('http://localhost:8080/x')).toBe('http://localhost:8080');
    expect(() => normalizeServer('ftp://x')).toThrow();
  });

  it('puts config and cache where each OS expects them', () => {
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'snitch'));
    expect(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe('/x/snitch');
    expect(cacheDir({ XDG_CACHE_HOME: '/c' }, 'linux')).toBe('/c/snitch');
    expect(cacheDir({}, 'darwin')).toMatch(/Library\/Caches\/snitch$/);
    expect(configDir({ SNITCH_CONFIG_DIR: '/override' }, 'darwin')).toBe('/override');
  });

  it('renders the timeline against the video and the screen', () => {
    const r = renderTimeline(timelineText, { ticket: { device: { screen: { width: 400, height: 800, scale: 3, orientation: 'portrait' } } } } as any);
    expect(r.lines[0]).toMatch(/^ *-300\.0s {6}APP {3}launch$/);
    expect(r.lines.find((l) => l.includes('TOUCH'))).toMatch(/v\d\d {2}TOUCH \d+,\d+ pt/);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.every((l) => /ERROR|WARN|→ (?:[45]\d\d|failed|[a-z])/i.test(l))).toBe(true);
  });
});
