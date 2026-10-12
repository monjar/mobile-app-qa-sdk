/**
 * The S3 driver against a real S3-compatible server. Runs only when
 * SNITCH_TEST_S3_ENDPOINT is set; CI points it at SeaweedFS:
 *
 *   docker run -p 8333:8333 chrislusf/seaweedfs server -s3
 *   SNITCH_TEST_S3_ENDPOINT=http://127.0.0.1:8333 SNITCH_TEST_S3_BUCKET=snitch-test \
 *   SNITCH_TEST_S3_ACCESS_KEY_ID=… SNITCH_TEST_S3_SECRET_ACCESS_KEY=… npm test -w server -- s3
 *
 * Path-style addressing, a bucket created on demand, and every object under a
 * per-run prefix that is removed afterwards.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInfo } from '@snitch/contract';
import type { S3Config } from '../src/config';
import { S3BlobStore } from '../src/storage/s3BlobStore';
import { drain, scheduleRecurring } from '../src/worker/worker';
import { adminFetch, harness, login, sha256 } from './helpers';

const endpoint = process.env.SNITCH_TEST_S3_ENDPOINT?.replace(/\/+$/, '');

// aws4fetch retries 5xx answers for up to ~50 s; let a failing server fail with its error, not a timeout.
describe.skipIf(!endpoint)('S3 blob store (real server)', { timeout: 120_000 }, () => {
  const cfg: S3Config = {
    endpoint: endpoint ?? '',
    region: process.env.SNITCH_TEST_S3_REGION ?? 'us-east-1',
    bucket: process.env.SNITCH_TEST_S3_BUCKET ?? 'snitch-test',
    accessKeyId: process.env.SNITCH_TEST_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.SNITCH_TEST_S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
  };
  const prefix = `test-${Date.now()}-${randomBytes(4).toString('hex')}/`;
  // A small page size so listing has to follow continuation tokens.
  const store = new S3BlobStore(cfg, 2);
  const dir = mkdtempSync(join(tmpdir(), 'snitch-s3-'));
  const file = (name: string, body: Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };
  const read = async (stream: NodeJS.ReadableStream) => {
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(chunk as Buffer);
    return Buffer.concat(parts);
  };

  beforeAll(async () => {
    const client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: 's3' });
    const res = await client.fetch(`${cfg.endpoint}/${cfg.bucket}`, { method: 'PUT' });
    // 409: it exists already (BucketAlreadyOwnedByYou / BucketAlreadyExists).
    if (!res.ok && res.status !== 409) throw new Error(`creating bucket ${cfg.bucket} failed: ${res.status} ${await res.text()}`);
  });

  afterAll(async () => {
    if (!endpoint) return;
    for (const b of await store.list(prefix)) await store.delete(b.key);
  });

  it('is reachable', async () => {
    await expect(store.check()).resolves.toBeUndefined();
  });

  it('puts, gets, ranges, heads, lists and deletes', async () => {
    const body = Buffer.from('hello snitch, from a real bucket');
    const key = `${prefix}objects/hello world+1.txt`;
    await store.putFile(key, file('hello.txt', body), 'text/plain');
    expect((await store.readAll(key)).equals(body)).toBe(true);
    expect(await read(await store.read(key, { start: 6, end: 11 }))).toEqual(body.subarray(6, 12));
    expect(await read(await store.read(key))).toEqual(body);
    expect(await store.head(key)).toEqual({ size: body.length });
    expect(await store.head(`${prefix}objects/missing`)).toBeNull();

    for (const n of ['a', 'b', 'c', 'd', 'e']) await store.putFile(`${prefix}list/${n}.bin`, file(`${n}.bin`, Buffer.from(n.repeat(3))), 'application/octet-stream');
    const listed = await store.list(`${prefix}list/`);
    expect(listed.map((b) => b.key)).toEqual(['a', 'b', 'c', 'd', 'e'].map((n) => `${prefix}list/${n}.bin`));
    expect(listed.every((b) => b.size === 3 && b.lastModified > 0)).toBe(true);
    expect((await store.list(`${prefix}objects/`)).map((b) => b.key)).toEqual([key]);

    await store.delete(key);
    expect(await store.head(key)).toBeNull();
    await expect(store.readAll(key)).rejects.toThrow(/404/);
    // Deleting what isn't there is fine.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('stores a multi-megabyte file intact', async () => {
    const big = randomBytes(12 * 1024 * 1024 + 7);
    const key = `${prefix}big/video.mp4`;
    await store.putFile(key, file('big.bin', big), 'video/mp4');
    expect(await store.head(key)).toEqual({ size: big.length });
    expect(sha256(await store.readAll(key))).toBe(sha256(big));
    const tail = await read(await store.read(key, { start: big.length - 1000, end: big.length - 1 }));
    expect(tail).toEqual(big.subarray(big.length - 1000));
  });

  it('takes scheduled backups into a separate bucket and prunes old ones', async () => {
    const backupPrefix = `${prefix}backups/`;
    const h = await harness({ config: { backup: { intervalHours: 1, keep: 2, s3: cfg, s3Prefix: backupPrefix } } });
    const s = await login(h);
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      scheduleRecurring(h.deps);
      await drain(h.deps);
      made.push(h.deps.settings.get<{ lastKey: string }>('backup', { lastKey: '' }).lastKey);
      h.clock.t += 3600_000;
    }
    expect(new Set(made).size).toBe(3);
    // Something else under the prefix is not a backup and stays.
    await h.deps.backupStore.putFile(`${backupPrefix}README.txt`, file('readme.txt', Buffer.from('mine')), 'text/plain');
    scheduleRecurring(h.deps);
    await drain(h.deps);
    const latest = h.deps.settings.get<{ lastKey: string }>('backup', { lastKey: '' }).lastKey;
    expect((await h.deps.backupStore.list(backupPrefix)).map((b) => b.key)).toEqual([`${backupPrefix}README.txt`, made[2], latest].sort());

    const info = (await (await adminFetch(h, s, '/server')).json()) as ServerInfo;
    expect(info.backup).toMatchObject({ enabled: true, target: 's3', keep: 2, lastKey: latest, lastError: null });
    const restored = join(dir, 'restored.db');
    writeFileSync(restored, gunzipSync(await h.deps.backupStore.readAll(latest)));
    const db = new Database(restored, { readonly: true });
    expect(db.prepare('SELECT slug FROM projects').all()).toEqual([{ slug: 'mochiro' }]);
    db.close();
  });
});
