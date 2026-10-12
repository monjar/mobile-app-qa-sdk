/* eslint-disable @typescript-eslint/no-explicit-any -- test bodies are asserted field by field */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SERVER_FEATURES, type ServerInfo } from '@snitch/contract';
import { drain, scheduleRecurring } from '../src/worker/worker';
import { backupName, backupTarget, runBackup } from '../src/worker/backup';
import { adminFetch, harness, login, type Harness } from './helpers';

const backupConfig = (intervalHours = 24, keep = 2) => ({ backup: { intervalHours, keep, s3: null, s3Prefix: 'snitch-backups/' } });

async function keys(h: Harness): Promise<string[]> {
  return (await h.deps.blobs.list('backups/')).map((b) => b.key);
}

/** Opens a gzipped backup as a database. */
async function openBackup(h: Harness, key: string): Promise<Database.Database> {
  const file = join(mkdtempSync(join(tmpdir(), 'snitch-restore-')), 'restored.db');
  writeFileSync(file, gunzipSync(await h.deps.blobs.readAll(key)));
  return new Database(file, { readonly: true });
}

describe('scheduled backups', () => {
  it('backs the database up into the blob store and reports it in ServerInfo', async () => {
    const h = await harness({ config: backupConfig() });
    const s = await login(h);
    scheduleRecurring(h.deps);
    await drain(h.deps);
    const [key] = await keys(h);
    expect(key).toBe(`backups/${backupName(h.clock.t)}`);
    expect(key).toBe('backups/snitch-20261007T120000Z.db.gz');
    const restored = await openBackup(h, key!);
    expect(restored.prepare('SELECT slug FROM projects').all()).toEqual([{ slug: 'mochiro' }]);
    restored.close();

    const info = (await (await adminFetch(h, s, '/server')).json()) as ServerInfo;
    expect(info.features).toEqual([...SERVER_FEATURES]);
    expect(info.backup).toEqual({
      enabled: true,
      intervalHours: 24,
      keep: 2,
      target: 'storage',
      lastAt: h.clock.t,
      lastKey: key,
      lastBytes: (await h.deps.blobs.head(key!))!.size,
      lastError: null,
    });
  });

  it('keeps only the newest backups and leaves other files alone', async () => {
    const h = await harness({ config: backupConfig(24, 2) });
    const dir = mkdtempSync(join(tmpdir(), 'snitch-other-'));
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    await h.deps.blobs.putFile('backups/notes.txt', join(dir, 'notes.txt'), 'text/plain');
    const made: string[] = [];
    for (let i = 0; i < 4; i++) {
      made.push((await runBackup(h.deps, backupTarget(h.deps), 2)).key);
      h.clock.t += 3600_000;
    }
    expect(await keys(h)).toEqual(['backups/notes.txt', made[2], made[3]].sort());
  });

  it('records a failure and lets the job retry', async () => {
    const h = await harness({ config: backupConfig() });
    await runBackup(h.deps, backupTarget(h.deps), 2);
    const good = h.deps.settings.get<any>('backup', null);
    h.clock.t += 86_400_000;
    h.deps.backupStore = Object.assign(Object.create(h.deps.blobs) as typeof h.deps.blobs, { putFile: () => Promise.reject(new Error('disk full')) });
    scheduleRecurring(h.deps);
    await drain(h.deps);
    const status = h.deps.settings.get<any>('backup', null);
    expect(status).toEqual({ ...good, lastError: 'disk full' });
    expect(h.deps.jobs.list('queued').map((j) => j.kind)).toContain('backup');
  });

  it('schedules one backup per interval, and none when off', async () => {
    const off = await harness();
    scheduleRecurring(off.deps);
    expect(off.deps.jobs.list(null).map((j) => j.kind)).not.toContain('backup');

    const h = await harness({ config: backupConfig(6) });
    scheduleRecurring(h.deps);
    scheduleRecurring(h.deps);
    expect(h.deps.jobs.list(null).filter((j) => j.kind === 'backup')).toHaveLength(1);
    h.clock.t += 6 * 3600_000;
    scheduleRecurring(h.deps);
    expect(h.deps.jobs.list(null).filter((j) => j.kind === 'backup')).toHaveLength(2);
  });
});
