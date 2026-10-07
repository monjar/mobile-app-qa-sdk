/**
 * Byte-range responses for attachments. Safari will not play a <video> whose
 * server ignores Range, so this is required, not an optimisation. Supports one
 * range per request: `bytes=a-b`, `bytes=a-` and `bytes=-n`.
 */
import { Readable } from 'node:stream';
import type { BlobRange, BlobStore } from '../storage/blobStore';

export type RangeResult = BlobRange | 'unsatisfiable' | null;

export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range: ignore and send the whole body (RFC 9110 allows this)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (size === 0) return 'unsatisfiable';
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export interface ServeBlobOptions {
  store: BlobStore;
  key: string;
  size: number;
  contentType: string;
  method: string;
  rangeHeader: string | undefined;
  filename: string;
  cacheControl: string;
  extraHeaders?: Record<string, string>;
}

export async function serveBlob(o: ServeBlobOptions): Promise<Response> {
  const headers = new Headers({
    'Content-Type': o.contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': o.cacheControl,
    'Content-Disposition': `inline; filename="${o.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    // Never let an uploaded file run as a page, whatever its bytes say.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    ...o.extraHeaders,
  });
  const range = parseRange(o.rangeHeader, o.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${o.size}`);
    return new Response(null, { status: 416, headers });
  }
  const status = range ? 206 : 200;
  const length = range ? range.end - range.start + 1 : o.size;
  headers.set('Content-Length', String(length));
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${o.size}`);
  if (o.method === 'HEAD') return new Response(null, { status, headers });
  const stream = await o.store.read(o.key, range ?? undefined);
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
}
