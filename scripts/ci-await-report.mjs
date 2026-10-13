#!/usr/bin/env node
/**
 * Waits until the CI server has a complete ticket whose description matches,
 * then downloads its attachments into --out (screenshot.jpg, video.mp4, …)
 * and writes ticket.json. Exits non-zero on timeout.
 *
 *   node scripts/ci-await-report.mjs --server http://127.0.0.1:8080 --description autoreport --out ./report --timeout 300
 *
 * Optional checks (each failure is listed, then the script exits 1):
 *   --expect-timeline log,net,screen   the timeline attachment parses and has events of these kinds
 *   --expect-log <text>                some timeline log line contains <text>
 *   --expect-net <text>                some timeline request URL contains <text>
 *   --expect-screen <name>             the report's screen is <name>
 *   --expect-checkin <platform>        the Devices page lists an active install of that platform
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://127.0.0.1:8080' },
    description: { type: 'string', default: 'autoreport' },
    out: { type: 'string', default: 'report' },
    timeout: { type: 'string', default: '300' },
    email: { type: 'string', default: 'ci@snitch.local' },
    password: { type: 'string', default: 'ci-password-123' },
    'expect-timeline': { type: 'string' },
    'expect-log': { type: 'string' },
    'expect-net': { type: 'string' },
    'expect-screen': { type: 'string' },
    'expect-checkin': { type: 'string' },
  },
});

const login = await fetch(`${o.server}/api/admin/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: o.email, password: o.password }),
});
if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (path) => {
  const r = await fetch(`${o.server}${path}`, { headers: { cookie } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r;
};

const deadline = Date.now() + Number(o.timeout) * 1000;
let ticket = null;
while (Date.now() < deadline) {
  const list = await (await get(`/api/admin/tickets?status=all&q=${encodeURIComponent(o.description)}`)).json();
  ticket = list.items.find((t) => t.uploadState !== 'pending') ?? null;
  if (ticket) break;
  if (list.items.length) process.stdout.write(`found ${list.items[0].key}, upload still pending…\n`);
  await new Promise((r) => setTimeout(r, 5000));
}
if (!ticket) {
  console.error(`No complete report matching "${o.description}" within ${o.timeout}s`);
  process.exit(1);
}
const detail = await (await get(`/api/admin/tickets/${ticket.id}`)).json();
mkdirSync(o.out, { recursive: true });
writeFileSync(join(o.out, 'ticket.json'), JSON.stringify(detail, null, 2));
const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'video/mp4': '.mp4', 'text/plain': '.txt', 'application/x-ndjson': '.ndjson' };
const files = {};
for (const a of detail.attachments.filter((a) => a.stored)) {
  const bytes = Buffer.from(await (await get(a.url)).arrayBuffer());
  const file = join(o.out, `${a.name}${ext[a.contentType] ?? ''}`);
  writeFileSync(file, bytes);
  files[a.name] = bytes;
  console.log(`${a.name}: ${bytes.length} bytes → ${file}`);
}
console.log(`${detail.ticket.key} (${detail.ticket.uploadState}) from ${detail.ticket.device.model} ${detail.ticket.osVersion}; screen ${detail.ticket.screen ?? '-'}; stats ${JSON.stringify(detail.ticket.stats)}`);
const failures = [];
if (detail.ticket.uploadState !== 'complete') failures.push('report arrived incomplete');

if (o['expect-timeline'] || o['expect-log'] || o['expect-net']) {
  // Same leniency as parseTimeline in contract/src/timeline.ts: skip lines that aren't JSON.
  const lines = files.timeline ? files.timeline.toString('utf8').split('\n').filter((l) => l.trim()) : [];
  const records = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const meta = records.find((r) => r.k === 'meta');
  const events = records.filter((r) => r.k !== 'meta');
  const counts = Object.fromEntries([...new Set(events.map((e) => e.k))].map((k) => [k, events.filter((e) => e.k === k).length]));
  console.log(`timeline: ${files.timeline ? `${events.length} events ${JSON.stringify(counts)}, meta ${JSON.stringify(meta ?? null)}` : 'missing'}`);
  for (const e of events.filter((e) => e.k === 'net').slice(-5)) console.log(`  net ${e.method} ${e.url} → ${e.status ?? e.error}`);
  for (const e of events.filter((e) => e.k === 'log').slice(-5)) console.log(`  log [${e.src}/${e.level}] ${String(e.msg).slice(0, 160)}`);
  if (!files.timeline) failures.push('no timeline attachment');
  else if (!meta || meta.v !== 1) failures.push('timeline has no v1 meta line');
  for (const kind of (o['expect-timeline'] ?? '').split(',').filter(Boolean)) {
    if (!counts[kind]) failures.push(`timeline has no "${kind}" events`);
  }
  if (o['expect-log'] && !events.some((e) => e.k === 'log' && String(e.msg).includes(o['expect-log']))) {
    failures.push(`no timeline log line contains "${o['expect-log']}"`);
  }
  if (o['expect-net'] && !events.some((e) => e.k === 'net' && String(e.url).includes(o['expect-net']))) {
    failures.push(`no timeline request URL contains "${o['expect-net']}"`);
  }
}
if (o['expect-screen'] && detail.ticket.screen !== o['expect-screen']) {
  failures.push(`screen is ${JSON.stringify(detail.ticket.screen)}, expected "${o['expect-screen']}"`);
}
if (o['expect-checkin']) {
  const devices = await (await get(`/api/admin/projects/${detail.project.id}/devices`)).json();
  const mine = devices.items.filter((d) => d.platform === o['expect-checkin'] && d.active);
  console.log(`devices: ${devices.items.length} installs; ${o['expect-checkin']}: ${JSON.stringify(mine.map((d) => ({ releaseType: d.releaseType, sdk: d.sdkVersion, signals: d.signals })))}`);
  if (!mine.length) failures.push(`no active ${o['expect-checkin']} install checked in`);
}
if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  process.exit(1);
}
