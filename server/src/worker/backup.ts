/**
 * Scheduled database backups (SNITCH_BACKUP_INTERVAL_HOURS > 0).
 *
 * SQLite's online backup copies the database page by page while the server
 * keeps serving, unlike `snitch backup` (VACUUM INTO), which holds the database
 * for the whole copy and suits a one-off from the CLI. The copy is gzipped and
 * uploaded as `snitch-<UTC time>.db.gz`, and all but the newest `keep` are
 * deleted. Attachments are not included: they already live in the blob store.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { BackupStatus } from '@snitch/contract';
import type { Deps } from '../deps';
import type { BlobStore } from '../storage/blobStore';
import { fileSize, tmpDir } from '../storage/partials';
import { ulid } from '../util/ids';
import { errorMessage, log } from '../log';

export const BACKUP_SETTING = 'backup';
/** Prefix inside the blob store when there is no separate backup bucket. */
export const STORAGE_BACKUP_PREFIX = 'backups/';
const BACKUP_NAME = /^snitch-\d{8}T\d{6}Z\.db\.gz$/;

interface BackupRecord {
  lastAt: number | null;
  lastKey: string | null;
  lastBytes: number | null;
  lastError: string | null;
}

const NO_BACKUP: BackupRecord = { lastAt: null, lastKey: null, lastBytes: null, lastError: null };

export interface BackupTarget {
  store: BlobStore;
  prefix: string;
}

export function backupTarget(deps: Deps): BackupTarget {
  return { store: deps.backupStore, prefix: deps.config.backup.s3 ? deps.config.backup.s3Prefix : STORAGE_BACKUP_PREFIX };
}

/** `snitch-20261013T094500Z.db.gz`: ISO 8601 basic format, so names sort by time and need no escaping anywhere. */
export function backupName(t: number): string {
  return `snitch-${new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}.db.gz`;
}

export function backupStatus(deps: Deps): BackupStatus {
  const b = deps.config.backup;
  return {
    enabled: b.intervalHours > 0,
    intervalHours: b.intervalHours,
    keep: b.keep,
    target: b.s3 ? 's3' : 'storage',
    ...deps.settings.get<BackupRecord>(BACKUP_SETTING, NO_BACKUP),
  };
}

/** Takes, uploads and prunes one backup, recording the outcome for ServerInfo.backup. */
export async function runBackup(deps: Deps, target: BackupTarget, keep: number): Promise<{ key: string; bytes: number; pruned: string[] }> {
  const previous = deps.settings.get<BackupRecord>(BACKUP_SETTING, NO_BACKUP);
  const t = deps.now();
  const key = `${target.prefix}${backupName(t)}`;
  const dir = tmpDir(deps.config.dataDir);
  const copy = join(dir, `backup-${ulid(t)}.db`);
  const gz = `${copy}.gz`;
  let bytes: number;
  try {
    await mkdir(dir, { recursive: true });
    await deps.db.backup(copy);
    await pipeline(createReadStream(copy), createGzip(), createWriteStream(gz, { mode: 0o600 }));
    bytes = await fileSize(gz);
    await target.store.putFile(key, gz, 'application/gzip');
  } catch (e) {
    deps.settings.set(BACKUP_SETTING, { ...previous, lastError: errorMessage(e) } satisfies BackupRecord);
    throw e;
  } finally {
    await rm(copy, { force: true });
    await rm(gz, { force: true });
  }

  // The backup exists now; a failed prune is reported but doesn't make the job retry (that would upload another one).
  let pruned: string[] = [];
  let lastError: string | null = null;
  try {
    pruned = await pruneBackups(target, keep);
  } catch (e) {
    lastError = `Backup uploaded, but deleting old backups failed: ${errorMessage(e)}`;
  }
  deps.settings.set(BACKUP_SETTING, { lastAt: t, lastKey: key, lastBytes: bytes, lastError } satisfies BackupRecord);
  log.info('backup', 'database backed up', { key, bytes, pruned: pruned.length });
  return { key, bytes, pruned };
}

/** Deletes all but the newest `keep` backups under the prefix. Other objects there are left alone. */
export async function pruneBackups(target: BackupTarget, keep: number): Promise<string[]> {
  const backups = (await target.store.list(target.prefix))
    .map((b) => b.key)
    .filter((k) => BACKUP_NAME.test(k.slice(target.prefix.length)))
    .sort()
    .reverse();
  const old = backups.slice(keep);
  for (const k of old) await target.store.delete(k);
  return old;
}
