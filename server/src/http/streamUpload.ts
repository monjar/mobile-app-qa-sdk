/**
 * Streams a raw request body to a temp file while counting bytes and hashing,
 * so a 30 MB video never sits in memory. Aborts as soon as the body exceeds
 * what the client declared.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './errors';

export interface StreamedFile {
  size: number;
  sha256: string;
  /** First 16 bytes, for magic-number checks. */
  head: Buffer;
}

export async function streamToFile(body: ReadableStream<Uint8Array> | null, path: string, maxBytes: number): Promise<StreamedFile> {
  if (!body) throw new HttpError(422, 'invalid_request', 'Empty body');
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) {
        cb(new HttpError(413, 'payload_too_large', 'Body is larger than declared'));
        return;
      }
      if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), meter, createWriteStream(path, { mode: 0o600 }));
  } catch (e) {
    await rm(path, { force: true });
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, 'invalid_request', 'Upload was interrupted');
  }
  return { size, sha256: hash.digest('hex'), head };
}

/** Whether the first bytes look like the declared type. Text types are not sniffed. */
export function magicMatches(contentType: string, head: Buffer): boolean {
  switch (contentType) {
    case 'image/jpeg':
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'video/mp4':
      return head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
    default:
      return !head.subarray(0, 16).includes(0); // text: no NUL bytes up front
  }
}
