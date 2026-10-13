import { createReadStream } from 'node:fs';
import { access, constants, copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { BlobInfo, BlobRange, BlobStore } from './blobStore';

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

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(this.path(key));
      return s.isFile() ? { size: s.size } : null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    // Walk only the directory the prefix names; keys are paths under the root.
    const slash = prefix.lastIndexOf('/');
    const dir = slash >= 0 ? this.path(prefix.slice(0, slash + 1)) : normalize(this.root);
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: BlobInfo[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const key = relative(normalize(this.root), full).split(sep).join('/');
      if (!key.startsWith(prefix) || key === '.probe') continue;
      const s = await stat(full).catch(() => null);
      if (s?.isFile()) out.push({ key, size: s.size, lastModified: s.mtimeMs });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
