#!/usr/bin/env node
/**
 * Waits until the CI server has a complete ticket whose description matches,
 * then downloads its attachments into --out (screenshot.jpg, video.mp4, …)
 * and writes ticket.json. Exits non-zero on timeout.
 *
 *   node scripts/ci-await-report.mjs --server http://127.0.0.1:8080 --description autoreport --out ./report --timeout 300
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
for (const a of detail.attachments.filter((a) => a.stored)) {
  const bytes = Buffer.from(await (await get(a.url)).arrayBuffer());
  const file = join(o.out, `${a.name}${ext[a.contentType] ?? ''}`);
  writeFileSync(file, bytes);
  console.log(`${a.name}: ${bytes.length} bytes → ${file}`);
}
console.log(`${detail.ticket.key} (${detail.ticket.uploadState}) from ${detail.ticket.device.model} ${detail.ticket.osVersion}; stats ${JSON.stringify(detail.ticket.stats)}`);
if (detail.ticket.uploadState !== 'complete') {
  console.error('Report arrived incomplete');
  process.exit(1);
}
