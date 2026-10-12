/**
 * Server configuration from environment variables (SNITCH_*). Everything has a
 * working default so `docker run ghcr.io/monjar/snitch-server` starts; the only
 * value worth setting on day one is SNITCH_PUBLIC_URL (links in issues/emails).
 *
 * SNITCH_SECRET_KEY encrypts integration tokens at rest. If unset, a random key
 * is generated once into <dataDir>/secret.key, which is fine as long as the key
 * file lives on the same volume as the database it protects.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { CHUNK_BYTES_DEFAULT, CHUNK_BYTES_MAX, CHUNK_BYTES_MIN } from '@snitch/contract';

export type TrustProxy = 'none' | 'xff' | 'fly' | 'cloudflare';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface BackupConfig {
  /** Hours between scheduled backups; 0 turns them off. */
  intervalHours: number;
  /** Backups kept; older ones are deleted after each run. */
  keep: number;
  /** A separate bucket (SNITCH_BACKUP_S3_*); null backs up into the blob store under `backups/`. */
  s3: S3Config | null;
  /** Key prefix inside that bucket. */
  s3Prefix: string;
}

/** Sign in with GitHub: an OAuth app's credentials plus who may use it. */
export interface GithubAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Members of this organization only (membership must be active). */
  allowedOrg: string | null;
  /** Create a member for an unknown GitHub user (only together with allowedOrg). */
  autoCreate: boolean;
  /** github.com, or a GitHub Enterprise Server host. */
  webUrl: string;
  apiUrl: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Absolute URL the server is reachable at, without a trailing slash. */
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  /** Directory with the built dashboard (index.html + assets). */
  publicDir: string;
  secretKey: string;
  previousSecretKey: string | null;
  bootstrapAdmin: { email: string; password: string } | null;
  storage: 'fs' | 's3';
  s3: S3Config | null;
  smtpUrl: string | null;
  mailFrom: string;
  retentionDays: number;
  trustProxy: TrustProxy;
  allowPrivateWebhooks: boolean;
  sessionDays: number;
  cookieSecure: boolean;
  /** Preferred chunk size for resumable attachment uploads. */
  uploadChunkBytes: number;
  backup: BackupConfig;
  githubAuth: GithubAuthConfig | null;
  /** Report intake limits. */
  limits: {
    reportsPerKeyPerHour: number;
    reportsPerIpPer10Min: number;
    configPerIpPerHour: number;
    loginPerIpPer15Min: number;
  };
}

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function num(name: string, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.min(max, Math.max(min, n));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name)?.toLowerCase();
  if (raw === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}

function loadS3(prefix: string, required: boolean): S3Config | null {
  const endpoint = str(`${prefix}_ENDPOINT`);
  const bucket = str(`${prefix}_BUCKET`);
  if (!required && !endpoint && !bucket) return null;
  const need = (n: string) => {
    const v = str(n);
    if (!v) throw new Error(`${n} is required${required ? ' when SNITCH_STORAGE=s3' : ` when ${prefix}_ENDPOINT or _BUCKET is set`}`);
    return v;
  };
  return {
    endpoint: need(`${prefix}_ENDPOINT`).replace(/\/+$/, ''),
    region: str(`${prefix}_REGION`) ?? 'auto',
    bucket: need(`${prefix}_BUCKET`),
    accessKeyId: need(`${prefix}_ACCESS_KEY_ID`),
    secretAccessKey: need(`${prefix}_SECRET_ACCESS_KEY`),
    forcePathStyle: bool(`${prefix}_FORCE_PATH_STYLE`, true),
  };
}

/** `a/b` → `a/b/`; empty (or `/`) → the bucket root. */
function keyPrefix(raw: string): string {
  const p = raw.replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

function loadGithubAuth(): GithubAuthConfig | null {
  const clientId = str('SNITCH_GITHUB_CLIENT_ID');
  const clientSecret = str('SNITCH_GITHUB_CLIENT_SECRET');
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) throw new Error('Set both SNITCH_GITHUB_CLIENT_ID and SNITCH_GITHUB_CLIENT_SECRET, or neither');
  const url = (name: string, fallback: string) => {
    const v = (str(name) ?? fallback).replace(/\/+$/, '');
    try {
      new URL(v);
    } catch {
      throw new Error(`${name} is not a valid URL: "${v}"`);
    }
    return v;
  };
  const allowedOrg = str('SNITCH_GITHUB_ALLOWED_ORG') ?? null;
  if (allowedOrg !== null && !/^[A-Za-z0-9-]{1,39}$/.test(allowedOrg)) throw new Error('SNITCH_GITHUB_ALLOWED_ORG must be a GitHub organization login');
  return {
    clientId,
    clientSecret,
    allowedOrg,
    autoCreate: bool('SNITCH_GITHUB_AUTO_CREATE', false),
    webUrl: url('SNITCH_GITHUB_WEB_URL', 'https://github.com'),
    apiUrl: url('SNITCH_GITHUB_API_URL', 'https://api.github.com'),
  };
}

function loadSecretKey(dataDir: string): string {
  const fromEnv = str('SNITCH_SECRET_KEY');
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SNITCH_SECRET_KEY must be at least 32 characters');
    return fromEnv;
  }
  const file = join(dataDir, 'secret.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, key + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes
  }
  return key;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const port = num('PORT', 8080, 1, 65535);
  const dataDir = resolve(str('SNITCH_DATA_DIR') ?? 'data');
  mkdirSync(dataDir, { recursive: true });

  const publicUrl = (str('SNITCH_PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');
  try {
    new URL(publicUrl);
  } catch {
    throw new Error(`SNITCH_PUBLIC_URL is not a valid URL: "${publicUrl}"`);
  }

  const adminEmail = str('SNITCH_BOOTSTRAP_ADMIN_EMAIL');
  const adminPassword = str('SNITCH_BOOTSTRAP_ADMIN_PASSWORD');
  if ((adminEmail && !adminPassword) || (!adminEmail && adminPassword)) {
    throw new Error('Set both SNITCH_BOOTSTRAP_ADMIN_EMAIL and SNITCH_BOOTSTRAP_ADMIN_PASSWORD, or neither');
  }

  const storage = (str('SNITCH_STORAGE') ?? 'fs') as 'fs' | 's3';
  if (storage !== 'fs' && storage !== 's3') throw new Error('SNITCH_STORAGE must be fs or s3');
  const s3 = storage === 's3' ? loadS3('SNITCH_S3', true) : null;

  const trustProxy = (str('SNITCH_TRUST_PROXY') ?? 'none') as TrustProxy;
  if (!['none', 'xff', 'fly', 'cloudflare'].includes(trustProxy)) {
    throw new Error('SNITCH_TRUST_PROXY must be one of none, xff, fly, cloudflare');
  }

  const config: ServerConfig = {
    host: str('HOST') ?? '0.0.0.0',
    port,
    publicUrl,
    dataDir,
    dbPath: str('SNITCH_DB_PATH') ?? join(dataDir, 'snitch.db'),
    publicDir: resolve(str('SNITCH_PUBLIC_DIR') ?? join(import.meta.dirname ?? '.', '..', 'public')),
    secretKey: loadSecretKey(dataDir),
    previousSecretKey: str('SNITCH_PREVIOUS_SECRET_KEY') ?? null,
    bootstrapAdmin: adminEmail && adminPassword ? { email: adminEmail, password: adminPassword } : null,
    storage,
    s3,
    smtpUrl: str('SNITCH_SMTP_URL') ?? null,
    mailFrom: str('SNITCH_MAIL_FROM') ?? 'Snitch <snitch@localhost>',
    retentionDays: num('SNITCH_RETENTION_DAYS', 90, 0, 36500),
    trustProxy,
    allowPrivateWebhooks: bool('SNITCH_ALLOW_PRIVATE_WEBHOOKS', false),
    sessionDays: num('SNITCH_SESSION_DAYS', 14, 1, 365),
    cookieSecure: bool('SNITCH_COOKIE_SECURE', publicUrl.startsWith('https://')),
    uploadChunkBytes: Math.floor(num('SNITCH_UPLOAD_CHUNK_BYTES', CHUNK_BYTES_DEFAULT, CHUNK_BYTES_MIN, CHUNK_BYTES_MAX)),
    backup: {
      intervalHours: num('SNITCH_BACKUP_INTERVAL_HOURS', 0, 0, 24 * 365),
      keep: Math.floor(num('SNITCH_BACKUP_KEEP', 7, 1, 1000)),
      s3: loadS3('SNITCH_BACKUP_S3', false),
      s3Prefix: keyPrefix(str('SNITCH_BACKUP_S3_PREFIX') ?? 'snitch-backups/'),
    },
    githubAuth: loadGithubAuth(),
    limits: {
      reportsPerKeyPerHour: num('SNITCH_REPORTS_PER_KEY_PER_HOUR', 120, 1),
      reportsPerIpPer10Min: num('SNITCH_REPORTS_PER_IP_PER_10_MIN', 20, 1),
      configPerIpPerHour: num('SNITCH_CONFIG_PER_IP_PER_HOUR', 120, 1),
      loginPerIpPer15Min: num('SNITCH_LOGIN_PER_IP_PER_15_MIN', 10, 1),
    },
    ...overrides,
  };
  return config;
}
