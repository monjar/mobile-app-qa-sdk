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

export type TrustProxy = 'none' | 'xff' | 'fly' | 'cloudflare';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
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
  let s3: S3Config | null = null;
  if (storage === 's3') {
    const need = (n: string) => {
      const v = str(n);
      if (!v) throw new Error(`${n} is required when SNITCH_STORAGE=s3`);
      return v;
    };
    s3 = {
      endpoint: need('SNITCH_S3_ENDPOINT').replace(/\/+$/, ''),
      region: str('SNITCH_S3_REGION') ?? 'auto',
      bucket: need('SNITCH_S3_BUCKET'),
      accessKeyId: need('SNITCH_S3_ACCESS_KEY_ID'),
      secretAccessKey: need('SNITCH_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: bool('SNITCH_S3_FORCE_PATH_STYLE', true),
    };
  }

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
