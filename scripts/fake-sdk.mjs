#!/usr/bin/env node
/**
 * A tiny Snitch client in Node: sends one report the way the mobile SDKs do
 * (create → PUT attachments → complete). Handy for trying a server, demos and CI.
 *
 *   node scripts/fake-sdk.mjs --server http://localhost:8080 --key snitch_pk_… \
 *     [--description "Text"] [--type bug] [--platform ios|android] [--release-type debug]
 *     [--screenshot file.jpg] [--video file.mp4] [--generate-media 5]
 *
 * --generate-media N makes a JPEG and an N-second H.264 MP4 with ffmpeg.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    server: { type: 'string', default: process.env.SNITCH_URL ?? 'http://localhost:8080' },
    key: { type: 'string', default: process.env.SNITCH_INGEST_KEY },
    description: { type: 'string', default: 'Sent from scripts/fake-sdk.mjs' },
    type: { type: 'string', default: 'bug' },
    platform: { type: 'string', default: 'ios' },
    'release-type': { type: 'string', default: 'debug' },
    screenshot: { type: 'string' },
    video: { type: 'string' },
    'generate-media': { type: 'string' },
    email: { type: 'string' },
  },
});
if (!o.key) {
  console.error('fake-sdk: --key (or SNITCH_INGEST_KEY) is required');
  process.exit(1);
}

let screenshotPath = o.screenshot;
let videoPath = o.video;
let videoSeconds = 0;
if (o['generate-media']) {
  videoSeconds = Number(o['generate-media']);
  const dir = mkdtempSync(join(tmpdir(), 'snitch-media-'));
  screenshotPath = join(dir, 'screenshot.jpg');
  videoPath = join(dir, 'video.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=393x852:rate=1', '-frames:v', '1', screenshotPath]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=392x848:rate=10:duration=${videoSeconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = [];
if (screenshotPath) files.push({ name: 'screenshot', contentType: screenshotPath.endsWith('.png') ? 'image/png' : 'image/jpeg', body: readFileSync(screenshotPath) });
if (videoPath) files.push({ name: 'video', contentType: 'video/mp4', body: readFileSync(videoPath), durationMs: (videoSeconds || 5) * 1000 });

const headers = { 'x-snitch-key': o.key, 'x-snitch-sdk': 'fake/0.1.0', 'user-agent': 'Snitch/0.1.0 (fake-sdk)' };
const report = {
  clientReportId: randomUUID(),
  type: o.type,
  description: o.description,
  ...(o.email ? { reporter: { email: o.email } } : {}),
  reportedAt: new Date().toISOString(),
  trigger: 'api',
  app: { id: 'io.github.monjar.snitch.fake', name: 'Fake SDK', version: '1.0.0', build: '1', releaseType: o['release-type'] },
  device: { platform: o.platform, osVersion: o.platform === 'ios' ? '26.0' : '15', model: o.platform === 'ios' ? 'iPhone16,2' : 'Pixel 8', locale: 'en_GB', network: 'wifi' },
  sdk: { name: 'snitch-fake', version: '0.1.0' },
  attachments: files.map((f) => ({ name: f.name, contentType: f.contentType, sizeBytes: f.body.length, sha256: sha(f.body), ...(f.durationMs ? { durationMs: f.durationMs } : {}) })),
};

async function call(method, path, body, extra = {}) {
  const res = await fetch(`${o.server}${path}`, { method, headers: { ...headers, ...extra }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const created = await call('POST', '/api/v1/reports', JSON.stringify(report), { 'content-type': 'application/json' });
for (const f of files) {
  await call('PUT', `/api/v1/reports/${created.reportId}/attachments/${f.name}`, f.body, {
    'content-type': f.contentType,
    'content-length': String(f.body.length),
    'x-content-sha256': sha(f.body),
  });
}
const done = await call('POST', `/api/v1/reports/${created.reportId}/complete`);
console.log(JSON.stringify(done));
