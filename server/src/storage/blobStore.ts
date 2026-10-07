/**
 * Where attachment bytes live. The database only stores keys. Two drivers:
 * the local filesystem (default; a Docker volume) and any S3-compatible bucket.
 */
import type { Readable } from 'node:stream';

export interface BlobRange {
  start: number;
  /** Inclusive. */
  end: number;
}

export interface BlobStore {
  readonly kind: 'fs' | 's3';
  /** Moves a fully written local temp file into the store under `key`. The temp file is gone afterwards. */
  putFile(key: string, tempPath: string, contentType: string): Promise<void>;
  /** Streams the blob, or a byte range of it. */
  read(key: string, range?: BlobRange): Promise<Readable>;
  /** Reads the whole blob into memory (small files only: email attachments). */
  readAll(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Cheap reachability check for /health/ready. */
  check(): Promise<void>;
}

export function attachmentKey(projectId: string, ticketId: string, attachmentId: string): string {
  return `projects/${projectId}/tickets/${ticketId}/${attachmentId}`;
}
