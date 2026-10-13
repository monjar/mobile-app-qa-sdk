#!/usr/bin/env node
/**
 * A tiny Snitch client in Node: sends one report the way the mobile SDKs do
 * (config check-in → create → PUT attachments, in chunks when the server takes
 * them → complete). Handy for trying a server, demos and CI.
 *
 *   node scripts/fake-sdk.mjs --server http://localhost:8080 --key snitch_pk_… \
 *     [--description "Text"] [--type bug] [--platform ios|android] [--release-type debug]
 *     [--screenshot file.jpg] [--video file.mp4] [--generate-media 5] [--timeline]
 *     [--chunk-bytes 65536]
 *
 * --generate-media N makes a JPEG and an N-second H.264 MP4 with ffmpeg.
 * --timeline attaches contract/fixtures/timeline.ndjson, moved to end now.
 * --chunk-bytes caps the chunk size (the server's own size applies otherwise).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    timeline: { type: 'boolean', default: false },
    'chunk-bytes': { type: 'string' },
    'install-id': { type: 'string' },
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

if (o.timeline) {
  // Shift the fixture so its last event is now, keeping the spacing.
  const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'contract', 'fixtures', 'timeline.ndjson'), 'utf8');
  const records = fixture.split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const meta = records.find((r) => r.k === 'meta');
  const shift = Date.now() - meta.end;
  const moved = records.map((r) =>
    r.k === 'meta'
      ? { ...r, platform: o.platform, start: r.start + shift, end: r.end + shift, videoStart: r.videoStart + shift, videoEnd: r.videoEnd + shift }
      : { ...r, t: r.t + shift },
  );
  files.push({ name: 'timeline', contentType: 'application/x-ndjson', body: Buffer.from(moved.map((r) => JSON.stringify(r)).join('\n') + '\n') });
}

const installId = o['install-id'] ?? randomUUID();
const headers = { 'x-snitch-key': o.key, 'x-snitch-sdk': 'fake/0.3.0', 'user-agent': 'Snitch/0.3.0 (fake-sdk)' };
const report = {
  clientReportId: randomUUID(),
  type: o.type,
  description: o.description,
  ...(o.email ? { reporter: { email: o.email } } : {}),
  reportedAt: new Date().toISOString(),
  trigger: 'api',
  app: { id: 'io.github.monjar.snitch.fake', name: 'Fake SDK', version: '1.0.0', build: '1', releaseType: o['release-type'] },
  device: { platform: o.platform, osVersion: o.platform === 'ios' ? '26.0' : '15', model: o.platform === 'ios' ? 'iPhone16,2' : 'Pixel 8', locale: 'en_GB', network: 'wifi' },
  sdk: { name: 'snitch-fake', version: '0.3.0' },
  installId,
  ...(o.timeline ? { screen: 'index' } : {}),
  attachments: files.map((f) => ({ name: f.name, contentType: f.contentType, sizeBytes: f.body.length, sha256: sha(f.body), ...(f.durationMs ? { durationMs: f.durationMs } : {}) })),
};

async function call(method, path, body, extra = {}) {
  const res = await fetch(`${o.server}${path}`, { method, headers: { ...headers, ...extra }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Check in the way an SDK does on its config fetch.
const query = new URLSearchParams({
  platform: o.platform,
  releaseType: o['release-type'],
  appVersion: report.app.version,
  build: report.app.build,
  os: report.device.osVersion,
  installId,
  appId: report.app.id,
  sdkVersion: report.sdk.version,
  model: report.device.model,
  signals: o.platform === 'ios' ? 'sim=1;profile=none;devices=0;receipt=none;at=none' : 'debuggable=1;installer=none;override=none',
  active: '1',
});
const config = await call('GET', `/api/v1/sdk/config?${query}`);
console.log(`config: enabled ${config.enabled}, features ${JSON.stringify(config.features ?? [])}`);

const created = await call('POST', '/api/v1/reports', JSON.stringify(report), { 'content-type': 'application/json' });
const chunkBytes = created.upload?.resumable ? Math.min(created.upload.chunkBytes, Number(o['chunk-bytes'] ?? Infinity)) : Infinity;
for (const f of files) {
  const base = {
    'content-type': f.contentType,
    'x-content-sha256': sha(f.body),
  };
  if (f.body.length <= chunkBytes) {
    await call('PUT', `/api/v1/reports/${created.reportId}/attachments/${f.name}`, f.body, { ...base, 'content-length': String(f.body.length) });
    continue;
  }
  let start = created.attachments.find((a) => a.name === f.name)?.receivedBytes ?? 0;
  let parts = 0;
  while (start < f.body.length) {
    const chunk = f.body.subarray(start, Math.min(start + chunkBytes, f.body.length));
    const end = start + chunk.length - 1;
    const r = await call('PUT', `/api/v1/reports/${created.reportId}/attachments/${f.name}`, chunk, {
      ...base,
      'content-length': String(chunk.length),
      'content-range': `bytes ${start}-${end}/${f.body.length}`,
      'x-chunk-sha256': sha(chunk),
    });
    parts++;
    start = r.state === 'stored' ? f.body.length : r.receivedBytes;
  }
  console.log(`${f.name}: ${f.body.length} bytes in ${parts} chunks`);
}
const done = await call('POST', `/api/v1/reports/${created.reportId}/complete`);
console.log(JSON.stringify(done));
