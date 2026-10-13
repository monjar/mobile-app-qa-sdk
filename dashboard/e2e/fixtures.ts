import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export const INGEST_KEY = 'snitch_pk_E2E00000000000000000000000';
export const BASE = 'http://127.0.0.1:8099';
const root = join(import.meta.dirname, '..', '..');

export function sendReport(description: string, opts: { type?: string; media?: boolean } = {}): { reportId: string; ticket: string } {
  const out = execFileSync(
    'node',
    [join(root, 'scripts/fake-sdk.mjs'), '--server', BASE, '--key', INGEST_KEY, '--description', description, '--type', opts.type ?? 'bug', ...(opts.media === false ? [] : ['--generate-media', '3'])],
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').pop()!);
}

export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('admin@e2e.test');
  await page.getByLabel('Password').fill('e2e-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: /Inbox/ })).toBeVisible();
}

const sdkHeaders = { 'x-snitch-key': INGEST_KEY, 'x-snitch-sdk': 'e2e/0.3.0' };

/** contract/fixtures/timeline.ndjson: a meta line, ten events, and two lines readers must skip. */
export const TIMELINE_FIXTURE = readFileSync(join(root, 'contract/fixtures/timeline.ndjson'));
/** meta.end of the fixture, used as the report time so offsets read as they would on a device. */
export const TIMELINE_END = 1791381302120;

export interface RawAttachment {
  name: string;
  contentType: string;
  body: Buffer;
  durationMs?: number;
}

/** An H.264 clip of ffmpeg's test pattern at 10 fps, like the clips the SDKs compose. */
export function makeVideo(seconds: number): Buffer {
  const path = join(mkdtempSync(join(tmpdir(), 'snitch-e2e-')), 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=392x848:rate=10:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
  return readFileSync(path);
}

/** Sends a report through the ingest API (create → PUT each attachment → complete) the way an SDK 0.3 does. */
export async function sendReportWith(opts: {
  description: string;
  trigger?: string;
  screen?: string;
  reportedAt?: number;
  attachments?: RawAttachment[];
}): Promise<{ reportId: string; ticket: string }> {
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const files = opts.attachments ?? [];
  const call = async (method: string, path: string, body?: string | Buffer, extra: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { ...sdkHeaders, ...extra }, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const report = {
    clientReportId: randomUUID(),
    type: 'bug',
    description: opts.description,
    reportedAt: new Date(opts.reportedAt ?? Date.now()).toISOString(),
    trigger: opts.trigger ?? 'gesture',
    app: { id: 'io.github.monjar.snitch.fake', name: 'Fake SDK', version: '1.0.0', build: '1', releaseType: 'debug' },
    device: { platform: 'ios', osVersion: '26.0', model: 'iPhone16,2', locale: 'en_GB', network: 'wifi' },
    sdk: { name: 'snitch-ios', version: '0.3.0' },
    ...(opts.screen ? { screen: opts.screen } : {}),
    attachments: files.map((f) => ({ name: f.name, contentType: f.contentType, sizeBytes: f.body.length, sha256: sha(f.body), ...(f.durationMs ? { durationMs: f.durationMs } : {}) })),
  };
  const created = await call('POST', '/api/v1/reports', JSON.stringify(report), { 'content-type': 'application/json' });
  for (const f of files) {
    await call('PUT', `/api/v1/reports/${created.reportId}/attachments/${f.name}`, f.body, { 'content-type': f.contentType, 'x-content-sha256': sha(f.body) });
  }
  return call('POST', `/api/v1/reports/${created.reportId}/complete`);
}

/** One remote-config fetch with the check-in fields, as SDK 0.3 sends at launch. */
export async function checkIn(query: Record<string, string>): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/sdk/config?${new URLSearchParams(query)}`, { headers: sdkHeaders });
  if (!res.ok) throw new Error(`check-in → ${res.status} ${await res.text()}`);
}
