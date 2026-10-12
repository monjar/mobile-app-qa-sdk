/**
 * Chunked uploads in progress. `<dataDir>/tmp/partial/<attachmentId>.part`
 * holds the verified prefix of the file and attachments.received_bytes mirrors
 * its size. When the two disagree (a crash between the append and the update)
 * the file wins: it only ever grows by whole, verified chunks.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deps } from '../deps';

export function tmpDir(dataDir: string): string {
  return join(dataDir, 'tmp');
}

export function partialDir(dataDir: string): string {
  return join(dataDir, 'tmp', 'partial');
}

export function partialPath(dataDir: string, attachmentId: string): string {
  return join(partialDir(dataDir), `${attachmentId}.part`);
}

/** Bytes on disk for a partial upload; 0 when there is none. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
}

export async function removePartials(dataDir: string, attachmentIds: string[]): Promise<void> {
  for (const id of attachmentIds) await rm(partialPath(dataDir, id), { force: true });
}

/**
 * Deletes partial files no pending upload owns any more (swept, deleted or
 * stored tickets, whatever a crash left behind) and loose temp files older
 * than `olderThanMs`. Returns how many files went.
 */
export async function sweepTempFiles(deps: Deps, olderThanMs: number): Promise<number> {
  let removed = 0;
  const parts = await readdir(partialDir(deps.config.dataDir)).catch(() => [] as string[]);
  const ids = parts.filter((f) => f.endsWith('.part')).map((f) => f.slice(0, -'.part'.length));
  const live = deps.tickets.pendingAttachmentIds(ids);
  for (const id of ids) {
    if (live.has(id)) continue;
    await rm(partialPath(deps.config.dataDir, id), { force: true });
    removed++;
  }
  const cutoff = deps.now() - olderThanMs;
  const dir = tmpDir(deps.config.dataDir);
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const s = await stat(join(dir, name)).catch(() => null);
    if (!s?.isFile() || s.mtimeMs >= cutoff) continue;
    await rm(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}
