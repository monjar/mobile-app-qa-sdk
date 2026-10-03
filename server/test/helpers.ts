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
