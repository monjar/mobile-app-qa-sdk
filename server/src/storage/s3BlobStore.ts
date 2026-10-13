/**
 * S3-compatible driver (AWS S3, Cloudflare R2, SeaweedFS, Garage, …) using
 * SigV4 via aws4fetch. Objects are written with a single PUT — attachments are
 * capped at 30 MB, well under every provider's single-PUT limit (5 GB), and so
 * are gzipped database backups of a QA team's server.
 *
 * Path-style (`http://host:8333/bucket/key`) is the default because it works
 * with every self-hosted store; virtual-hosted style needs wildcard DNS.
 */
import { AwsClient } from 'aws4fetch';
import { readFile, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { S3Config } from '../config';
import type { BlobInfo, BlobRange, BlobStore } from './blobStore';

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;
  private readonly client: AwsClient;

  /** `listPageSize` is the ListObjectsV2 page (max-keys); tests lower it to exercise pagination. */
  constructor(
    private readonly cfg: S3Config,
    private readonly listPageSize = 1000,
  ) {
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

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.client.fetch(this.url(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    return { size: Number(res.headers.get('content-length') ?? 0) };
  }

  /** ListObjectsV2, following continuation tokens until the listing is complete. */
  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': String(this.listPageSize) });
      if (token) q.set('continuation-token', token);
      const res = await this.client.fetch(`${this.bucketUrl()}?${q.toString()}`);
      const xml = await res.text();
      if (!res.ok) throw new Error(`S3 list ${prefix} failed: ${res.status} ${xml.slice(0, 200)}`);
      const page = parseListObjects(xml);
      out.push(...page.items);
      token = page.truncated ? page.nextToken : null;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return XML_ENTITIES[e] ?? m;
  });
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]!) : null;
}

/** The parts of a ListObjectsV2 response we use. The format is flat enough that a parser dependency isn't worth it. */
export function parseListObjects(xml: string): { items: BlobInfo[]; truncated: boolean; nextToken: string | null } {
  const items: BlobInfo[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tag(m[1]!, 'Key');
    if (key === null) continue;
    const modified = Date.parse(tag(m[1]!, 'LastModified') ?? '');
    items.push({ key, size: Number(tag(m[1]!, 'Size') ?? 0), lastModified: Number.isFinite(modified) ? modified : 0 });
  }
  return { items, truncated: tag(xml, 'IsTruncated') === 'true', nextToken: tag(xml, 'NextContinuationToken') };
}
