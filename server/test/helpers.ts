/**
 * Test harness: the real app on an in-memory database and a temp blob dir,
 * with a movable clock, a fake mailer and a programmable fetch.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import type { ReportCreate } from '@snitch/contract';
import { loadConfig, type ServerConfig } from '../src/config';
import { buildDeps } from '../src/bootstrap';
import { buildApp } from '../src/app';
import type { Deps } from '../src/deps';
import type { AppEnv } from '../src/http/env';
import type { MailMessage, Mailer } from '../src/mail/mailer';
import { openDb } from '../src/db/open';

export const INGEST_KEY = 'snitch_pk_0123456789ABCDEFGHJKMNPQRS';
export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };

export class FakeMailer implements Mailer {
  readonly driver = 'smtp' as const;
  sent: MailMessage[] = [];
  failNext = 0;
  async send(msg: MailMessage) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('smtp down');
    }
    this.sent.push(msg);
    return { messageId: `<${this.sent.length}@test>` };
  }
}

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export interface Harness {
  app: Hono<AppEnv>;
  deps: Deps;
  clock: { t: number };
  mailer: FakeMailer;
  fetchCalls: { url: string; init: RequestInit }[];
  onFetch: (h: FetchHandler) => void;
  projectId: string;
}

export function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'snitch-test-'));
  process.env.SNITCH_DATA_DIR = dataDir;
  process.env.SNITCH_SECRET_KEY = 'test-secret-key-that-is-long-enough-1234';
  return loadConfig({ dbPath: ':memory:', publicUrl: 'http://snitch.test', publicDir: join(dataDir, 'public'), ...overrides });
}

export async function harness(opts: { config?: Partial<ServerConfig>; withAdmin?: boolean } = {}): Promise<Harness> {
  const config = makeConfig(opts.config);
  const clock = { t: Date.parse('2026-10-07T12:00:00Z') };
  const mailer = new FakeMailer();
  const fetchCalls: Harness['fetchCalls'] = [];
  let handler: FetchHandler = () => new Response('no fetch handler', { status: 599 });
  const deps = buildDeps(config, {
    db: openDb(':memory:'),
    now: () => clock.t,
    mailer,
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    lookup: async (host) => (host.endsWith('.internal') || host === 'localhost' ? ['10.0.0.5'] : ['93.184.216.34']),
  });
  const project = deps.projects.create({ name: 'Mochiro', slug: 'mochiro', ticketPrefix: 'MOCH' });
  deps.projects.createKey(project.id, 'default', INGEST_KEY);
  if (opts.withAdmin !== false) await deps.users.create({ ...ADMIN, role: 'admin' });
  return { app: buildApp(deps), deps, clock, mailer, fetchCalls, onFetch: (h) => (handler = h), projectId: project.id };
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'contract', 'fixtures', name), 'utf8')) as T;
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function jpeg(size = 2048): Buffer {
  const b = Buffer.alloc(size, 7);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  return b;
}

export function mp4(size = 4096): Buffer {
  const b = Buffer.alloc(size, 3);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}

/** A valid iOS report with the given attachment bodies declared. */
export function report(files: { screenshot?: Buffer; video?: Buffer } = {}, patch: Partial<ReportCreate> = {}): ReportCreate {
  const base = fixture<ReportCreate>('report.create.ios.json');
  const attachments: ReportCreate['attachments'] = [];
  if (files.screenshot) attachments.push({ name: 'screenshot', contentType: 'image/jpeg', sizeBytes: files.screenshot.length, sha256: sha256(files.screenshot), width: 1179, height: 2556 });
  if (files.video) attachments.push({ name: 'video', contentType: 'video/mp4', sizeBytes: files.video.length, sha256: sha256(files.video), width: 393, height: 852, durationMs: 15000 });
  return { ...base, clientReportId: crypto.randomUUID(), attachments, ...patch };
}

export const sdkHeaders = (extra: Record<string, string> = {}) => ({ 'x-snitch-key': INGEST_KEY, 'content-type': 'application/json', ...extra });

export async function postReport(h: Harness, body: unknown, key = INGEST_KEY) {
  return h.app.request('/api/v1/reports', { method: 'POST', headers: sdkHeaders({ 'x-snitch-key': key }), body: JSON.stringify(body) });
}

export async function putAttachment(h: Harness, reportId: string, name: string, body: Buffer, contentType: string, headers: Record<string, string> = {}) {
  return h.app.request(`/api/v1/reports/${reportId}/attachments/${name}`, {
    method: 'PUT',
    headers: { 'x-snitch-key': INGEST_KEY, 'content-type': contentType, 'content-length': String(body.length), 'x-content-sha256': sha256(body), ...headers },
    body,
  });
}

/** Sends a full report (create → upload → complete) and returns the ticket id. */
export async function sendReport(h: Harness, files: { screenshot?: Buffer; video?: Buffer } = { screenshot: jpeg(), video: mp4() }, patch: Partial<ReportCreate> = {}): Promise<string> {
  const res = await postReport(h, report(files, patch));
  const created = (await res.json()) as { reportId: string };
  if (files.screenshot) await putAttachment(h, created.reportId, 'screenshot', files.screenshot, 'image/jpeg');
  if (files.video) await putAttachment(h, created.reportId, 'video', files.video, 'video/mp4');
  const done = await h.app.request(`/api/v1/reports/${created.reportId}/complete`, { method: 'POST', headers: sdkHeaders() });
  if (done.status !== 200) throw new Error(`complete failed: ${done.status} ${await done.text()}`);
  return created.reportId;
}

export interface Session {
  cookie: string;
  csrf: string;
}

export async function login(h: Harness, creds = ADMIN): Promise<Session> {
  const res = await h.app.request('/api/admin/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(creds) });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const body = (await res.json()) as { csrfToken: string };
  return { cookie, csrf: body.csrfToken };
}

export function adminFetch(h: Harness, s: Session, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = init.method ?? 'GET';
  return h.app.request(`/api/admin${path}`, {
    method,
    headers: {
      cookie: s.cookie,
      ...(method !== 'GET' && method !== 'HEAD' ? { 'x-csrf-token': s.csrf } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** PUTs one Content-Range chunk of `file` (bytes start..end inclusive). */
export async function putChunk(
  h: Harness,
  reportId: string,
  name: string,
  file: Buffer,
  contentType: string,
  start: number,
  end: number,
  headers: Record<string, string> = {},
) {
  const chunk = file.subarray(start, end + 1);
  return h.app.request(`/api/v1/reports/${reportId}/attachments/${name}`, {
    method: 'PUT',
    headers: {
      'x-snitch-key': INGEST_KEY,
      'content-type': contentType,
      'content-length': String(chunk.length),
      'content-range': `bytes ${start}-${end}/${file.length}`,
      'x-content-sha256': sha256(file),
      'x-chunk-sha256': sha256(chunk),
      ...headers,
    },
    body: chunk,
  });
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  comments: { id: number; body: string }[];
}

export interface FakeGithubIdentity {
  user: { id: number; login: string; name: string | null };
  emails: { email: string; verified: boolean; primary: boolean }[];
  /** org login → membership state. */
  orgs: Record<string, 'active' | 'pending'>;
}

/**
 * A small in-memory GitHub for escalation, issue sync and sign-in tests: the
 * issues API (create, search by marker, update, comments) and the OAuth
 * endpoints plus the user API that sign-in calls.
 */
export class FakeGithub {
  readonly issues = new Map<number, FakeIssue>();
  readonly calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  /** Statuses for the next issue writes (POST/PATCH), e.g. [502] for one transient failure. */
  failWrites: number[] = [];
  /** OAuth code → access token, and access token → who it belongs to. */
  readonly codes = new Map<string, string>();
  readonly tokens = new Map<string, FakeGithubIdentity>();
  private nextIssue = 1;
  private nextComment = 9001;
  /** A tiny Git data API: blobs, trees (path → blob sha), commits and branch refs. */
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  readonly refs = new Map<string, string>();
  /** False: the token lacks Contents: write (403 on every git write). */
  contentsWritable = true;
  /** Statuses for the next ref updates, e.g. [422] for a branch that moved underneath. */
  failRefUpdates: number[] = [];
  private nextSha = 1;

  constructor(
    readonly owner = 'monjar',
    readonly repo = 'mochiro',
    readonly web = 'https://github.com',
    readonly api = 'https://api.github.com',
  ) {}

  /** Registers a GitHub user who will sign in with `code`. */
  signsInWith(code: string, identity: FakeGithubIdentity): void {
    const token = `gho_${code}`;
    this.codes.set(code, token);
    this.tokens.set(token, identity);
  }

  writes(): { method: string; path: string; body: unknown }[] {
    return this.calls.filter((c) => c.method !== 'GET');
  }

  /** A file's bytes on `branch`, or null. */
  fileAt(branch: string, path: string): Buffer | null {
    const head = this.refs.get(branch);
    const blob = head ? this.trees.get(this.commits.get(head)!.tree)!.get(path) : undefined;
    return blob ? this.blobs.get(blob)! : null;
  }

  private sha(): string {
    return (this.nextSha++).toString(16).padStart(40, '0');
  }

  private git(rest: string, method: string, body: Record<string, unknown> | null): Response | null {
    if (rest === '' && method === 'GET') return Response.json({ full_name: `${this.owner}/${this.repo}`, html_url: `${this.web}/${this.owner}/${this.repo}`, has_issues: true });
    if (!rest.startsWith('/git/')) return null;
    if (method !== 'GET' && !this.contentsWritable) return Response.json({ message: 'Resource not accessible by personal access token' }, { status: 403 });
    if (rest === '/git/blobs' && method === 'POST') {
      const sha = this.sha();
      this.blobs.set(sha, Buffer.from(String(body?.content), 'base64'));
      return Response.json({ sha }, { status: 201 });
    }
    if (rest === '/git/trees' && method === 'POST') {
      const tree = new Map(body?.base_tree ? this.trees.get(String(body.base_tree)) : []);
      for (const e of body?.tree as { path: string; sha: string }[]) tree.set(e.path, e.sha);
      const sha = this.sha();
      this.trees.set(sha, tree);
      return Response.json({ sha }, { status: 201 });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const sha = this.sha();
      this.commits.set(sha, { tree: String(body?.tree), parents: body?.parents as string[], message: String(body?.message) });
      return Response.json({ sha }, { status: 201 });
    }
    const commit = /^\/git\/commits\/(\w+)$/.exec(rest);
    if (commit && method === 'GET') {
      const c = this.commits.get(commit[1]!);
      return c ? Response.json({ sha: commit[1], tree: { sha: c.tree } }) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    const ref = /^\/git\/(?:ref|refs)\/heads\/(.+)$/.exec(rest);
    if (ref && method === 'GET') {
      const sha = this.refs.get(ref[1]!);
      return sha ? Response.json({ ref: `refs/heads/${ref[1]}`, object: { sha } }) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (ref && method === 'PATCH') {
      if (this.failRefUpdates.length) return Response.json({ message: 'Update is not a fast forward' }, { status: this.failRefUpdates.shift()! });
      const next = String(body?.sha);
      if (!this.commits.get(next)?.parents.includes(this.refs.get(ref[1]!) ?? '')) return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
      this.refs.set(ref[1]!, next);
      return Response.json({ ref: `refs/heads/${ref[1]}`, object: { sha: next } });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = String(body?.ref).replace(/^refs\/heads\//, '');
      if (this.refs.has(name)) return Response.json({ message: 'Reference already exists' }, { status: 422 });
      this.refs.set(name, String(body?.sha));
      return Response.json({ ref: body?.ref, object: { sha: body?.sha } }, { status: 201 });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }

  readonly handle: FetchHandler = (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    this.calls.push({ method, path: u.pathname, body, auth: headers.authorization ?? null });

    if (url.startsWith(`${this.web}/login/oauth/access_token`)) {
      const token = this.codes.get(String(body?.code));
      return Response.json(token ? { access_token: token, token_type: 'bearer', scope: 'read:user,user:email' } : { error: 'bad_verification_code' });
    }
    if (!url.startsWith(this.api)) return new Response('unknown host', { status: 599 });
    const path = u.pathname;
    const who = this.tokens.get((headers.authorization ?? '').replace(/^Bearer /, ''));
    if (path === '/user') return who ? Response.json(who.user) : new Response('Bad credentials', { status: 401 });
    if (path === '/user/emails') return who ? Response.json(who.emails) : new Response('Bad credentials', { status: 401 });
    const org = /^\/user\/memberships\/orgs\/([^/]+)$/.exec(path);
    if (org) {
      const state = who?.orgs[decodeURIComponent(org[1]!)];
      return state ? Response.json({ state, role: 'member' }) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (path === '/search/issues') {
      const marker = /"(snitch:ticket=[^"]+)"/.exec(u.searchParams.get('q') ?? '')?.[1];
      const items = [...this.issues.values()].filter((i) => marker && i.body.includes(marker)).map((i) => this.issueJson(i));
      return Response.json({ items });
    }

    const repoPath = `/repos/${this.owner}/${this.repo}`;
    if (!path.startsWith(repoPath)) return Response.json({ message: 'Not Found' }, { status: 404 });
    const rest = path.slice(repoPath.length);
    if (method !== 'GET' && this.failWrites.length) return new Response('upstream sad', { status: this.failWrites.shift()! });
    const git = this.git(rest, method, body);
    if (git) return git;
    if (rest === '/issues' && method === 'POST') {
      const issue: FakeIssue = { number: this.nextIssue++, title: String(body?.title), body: String(body?.body), state: 'open', stateReason: null, comments: [] };
      this.issues.set(issue.number, issue);
      return Response.json(this.issueJson(issue), { status: 201 });
    }
    const m = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
    const issue = m ? this.issues.get(Number(m[1])) : undefined;
    if (!m || !issue) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (!m[2] && method === 'PATCH') {
      if (body?.state === 'closed') {
        issue.state = 'closed';
        issue.stateReason = String(body.state_reason ?? 'completed');
      } else if (body?.state === 'open') {
        issue.state = 'open';
        issue.stateReason = 'reopened';
      }
      return Response.json(this.issueJson(issue));
    }
    if (m[2] && method === 'POST') {
      const comment = { id: this.nextComment++, body: String(body?.body) };
      issue.comments.push(comment);
      return Response.json({ ...comment, html_url: `${this.issueJson(issue).html_url}#issuecomment-${comment.id}` }, { status: 201 });
    }
    if (m[2] && method === 'GET') return Response.json(issue.comments);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };

  issueJson(i: FakeIssue) {
    return { number: i.number, html_url: `https://github.com/${this.owner}/${this.repo}/issues/${i.number}`, state: i.state, state_reason: i.stateReason, body: i.body, title: i.title };
  }
}
