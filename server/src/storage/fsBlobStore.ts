import { createReadStream } from 'node:fs';
import { access, constants, copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { BlobRange, BlobStore } from './blobStore';

export class FsBlobStore implements BlobStore {
  readonly kind = 'fs' as const;

  constructor(private readonly root: string) {}

  async putFile(key: string, tempPath: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rename(tempPath, dest);
    } catch (e) {
      // EXDEV: temp dir on another filesystem (e.g. a tmpfs) — copy then delete.
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await copyFile(tempPath, dest);
      await unlink(tempPath);
    }
  }

  async read(key: string, range?: BlobRange): Promise<Readable> {
    const p = this.path(key);
    await access(p, constants.R_OK);
    return createReadStream(p, range ? { start: range.start, end: range.end } : {});
  }

  readAll(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async check(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = join(this.root, '.probe');
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
  }

  private path(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root) + sep)) throw new Error('blob key escapes the store root');
    return p;
  }
}
