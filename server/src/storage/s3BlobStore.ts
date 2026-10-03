/**
 * S3-compatible driver (AWS S3, Cloudflare R2, SeaweedFS, Garage, …) using
 * SigV4 via aws4fetch. Objects are written with a single PUT — attachments are
 * capped at 30 MB, well under every provider's single-PUT limit.
 */
import { AwsClient } from 'aws4fetch';
import { readFile, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { S3Config } from '../config';
import type { BlobRange, BlobStore } from './blobStore';

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly client: AwsClient;

  constructor(private readonly cfg: S3Config) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3',
    });
  }

  async putFile(key: string, tempPath: string, contentType: string): Promise<void> {
    const body = await readFile(tempPath);
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body,
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
    });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    await unlink(tempPath);
  }

  async read(key: string, range?: BlobRange): Promise<Readable> {
    const headers: Record<string, string> = {};
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    const res = await this.client.fetch(this.url(key), { headers });
    if (!res.ok || !res.body) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  }

  async readAll(key: string): Promise<Buffer> {
    const res = await this.client.fetch(this.url(key));
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }

  async check(): Promise<void> {
    const res = await this.client.fetch(`${this.bucketUrl()}?list-type=2&max-keys=1`);
    if (!res.ok) throw new Error(`S3 bucket check failed: ${res.status}`);
  }

  private bucketUrl(): string {
    if (this.cfg.forcePathStyle) return `${this.cfg.endpoint}/${this.cfg.bucket}`;
    const u = new URL(this.cfg.endpoint);
    return `${u.protocol}//${this.cfg.bucket}.${u.host}`;
  }

  private url(key: string): string {
    return `${this.bucketUrl()}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
}
