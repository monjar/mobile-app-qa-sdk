import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { parseRange } from '../src/http/range';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../src/crypto/passwords';
import { SecretBox } from '../src/crypto/secretBox';
import { isPrivateAddress } from '../src/integrations/webhook';
import { migrate, schemaVersion } from '../src/db/open';
import { MIGRATIONS } from '../src/db/migrations';
import { deriveTitle } from '../src/repo/tickets';
import { backoffMs } from '../src/repo/jobs';
import { magicMatches } from '../src/http/streamUpload';
import { RateLimiter } from '../src/http/rateLimit';
import { ulid } from '../src/util/ids';
import { smtpOptions } from '../src/mail/mailer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHUNK_BYTES_MAX, CHUNK_BYTES_MIN } from '@snitch/contract';
import { parseListObjects } from '../src/storage/s3BlobStore';
import { FsBlobStore } from '../src/storage/fsBlobStore';
import type { BlobStore } from '../src/storage/blobStore';
import { KeyedLock } from '../src/util/keyedLock';
import { loadConfig } from '../src/config';
import { backupName } from '../src/worker/backup';

describe('parseRange', () => {
  it.each([
    ['bytes=0-1', 10, { start: 0, end: 1 }],
    ['bytes=5-', 10, { start: 5, end: 9 }],
    ['bytes=-3', 10, { start: 7, end: 9 }],
    ['bytes=-30', 10, { start: 0, end: 9 }],
    ['bytes=0-100', 10, { start: 0, end: 9 }],
    ['bytes=10-', 10, 'unsatisfiable'],
    ['bytes=5-2', 10, 'unsatisfiable'],
    ['bytes=-0', 10, 'unsatisfiable'],
    ['bytes=0-1,3-4', 10, null],
    ['items=0-1', 10, null],
    [undefined, 10, null],
  ] as const)('%s of %i', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe('passwords', () => {
  it('verifies the right password only', async () => {
    const h = await hashPassword('hunter2 hunter2');
    expect(await verifyPassword('hunter2 hunter2', h)).toBe(true);
    expect(await verifyPassword('hunter2', h)).toBe(false);
    expect(await verifyPassword('anything', DUMMY_HASH)).toBe(false);
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });
});

describe('SecretBox', () => {
  it('round-trips and supports key rotation', () => {
    const old = new SecretBox('old-secret-old-secret-old-secret-123');
    const sealed = old.seal('ghp_token');
    expect(old.open(sealed)).toBe('ghp_token');
    const rotated = new SecretBox('new-secret-new-secret-new-secret-456', 'old-secret-old-secret-old-secret-123');
    expect(rotated.open(sealed)).toBe('ghp_token');
    const other = new SecretBox('other-secret-other-secret-other-789');
    expect(() => other.open(sealed)).toThrow();
    expect(rotated.seal('x')).not.toBe(rotated.seal('x'));
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['10.1.2.3', true],
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['172.20.0.1', true],
    ['192.168.1.1', true],
    ['100.64.0.1', true],
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false],
    ['2606:4700::1111', false],
    ['172.32.0.1', false],
  ])('%s → %s', (ip, expected) => expect(isPrivateAddress(ip)).toBe(expected));
});

describe('migrations', () => {
  it('migrates a fresh database to the latest version and is idempotent', () => {
    const db = new Database(':memory:');
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });

  it('refuses a database from a newer server', () => {
    const db = new Database(':memory:');
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this server supports/);
  });

  it('applies only the missing steps', () => {
    const db = new Database(':memory:');
    migrate(db, ['CREATE TABLE a (x)']);
    migrate(db, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)']);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'a' }, { name: 'b' }]);
  });
});

describe('small helpers', () => {
  it('derives titles from the first non-empty line', () => {
    expect(deriveTitle('\n\n  Crash on launch \nmore', 'Bug')).toBe('Crash on launch');
    expect(deriveTitle('   ', 'Idea')).toBe('Idea report');
    expect(deriveTitle('x'.repeat(200), 'Bug')).toHaveLength(118);
  });

  it('backs off exponentially with a cap', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(30)).toBe(6 * 3600_000);
  });

  it('sniffs magic numbers', () => {
    expect(magicMatches('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(magicMatches('image/jpeg', Buffer.from('<html>'))).toBe(false);
    expect(magicMatches('video/mp4', Buffer.from('\0\0\0\x18ftypisom', 'latin1'))).toBe(true);
    expect(magicMatches('text/plain', Buffer.from('hello'))).toBe(true);
    expect(magicMatches('text/plain', Buffer.from([0, 1, 2]))).toBe(false);
  });

  it('rate limits per window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.hit('k')).toBe(0);
    expect(rl.hit('k')).toBe(0);
    expect(rl.hit('k')).toBe(1);
    t = 1000;
    expect(rl.hit('k')).toBe(0);
  });

  it('ulids sort by time', () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('parses SMTP URLs', () => {
    expect(smtpOptions('smtps://u%40x:p%3Aw@mail.example.com')).toMatchObject({ host: 'mail.example.com', port: 465, secure: true, auth: { user: 'u@x', pass: 'p:w' } });
    expect(smtpOptions('smtp://mail.example.com:2525')).toMatchObject({ port: 2525, secure: false, auth: undefined });
    expect(() => smtpOptions('http://x')).toThrow();
  });
});

describe('S3 list parsing', () => {
  it('reads keys, sizes and the continuation token', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>backups/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys><IsTruncated>true</IsTruncated>
<Contents><Key>backups/a&amp;b.db.gz</Key><LastModified>2026-10-07T12:00:00.000Z</LastModified><ETag>"x"</ETag><Size>123</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>backups/c&#x27;d</Key><LastModified>bogus</LastModified><Size>0</Size></Contents>
<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken></ListBucketResult>`;
    expect(parseListObjects(xml)).toEqual({
      items: [
        { key: 'backups/a&b.db.gz', size: 123, lastModified: Date.parse('2026-10-07T12:00:00Z') },
        { key: "backups/c'd", size: 0, lastModified: 0 },
      ],
      truncated: true,
      nextToken: '1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=',
    });
    expect(parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ items: [], truncated: false, nextToken: null });
  });
});

describe('fs blob store', () => {
  it('heads and lists by prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'snitch-fs-'));
    const store: BlobStore = new FsBlobStore(root);
    const put = async (key: string, body: string) => {
      const tmp = join(mkdtempSync(join(tmpdir(), 'snitch-put-')), 'f');
      writeFileSync(tmp, body);
      await store.putFile(key, tmp, 'text/plain');
    };
    await put('backups/b.gz', 'bb');
    await put('backups/a.gz', 'a');
    await put('backups/deeper/c.gz', 'ccc');
    await put('projects/p/t/x', 'x');
    expect(await store.head('backups/b.gz')).toEqual({ size: 2 });
    expect(await store.head('backups/missing')).toBeNull();
    expect((await store.list('backups/')).map((b) => [b.key, b.size])).toEqual([
      ['backups/a.gz', 1],
      ['backups/b.gz', 2],
      ['backups/deeper/c.gz', 3],
    ]);
    expect((await store.list('backups/b')).map((b) => b.key)).toEqual(['backups/b.gz']);
    expect((await store.list('nothing/')).length).toBe(0);
    expect((await store.list('')).length).toBe(4);
  });
});

describe('KeyedLock', () => {
  it('runs work for one key in order and other keys in parallel', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const step = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
      if (name === 'a2') throw new Error('boom');
      return name;
    };
    const results = await Promise.allSettled([lock.run('a', step('a1', 20)), lock.run('a', step('a2', 1)), lock.run('a', step('a3', 1)), lock.run('b', step('b1', 1))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect(log.indexOf('a1:end')).toBeLessThan(log.indexOf('a2:start'));
    expect(log.indexOf('a2:end')).toBeLessThan(log.indexOf('a3:start'));
    expect(log.indexOf('b1:end')).toBeLessThan(log.indexOf('a1:end'));
    expect(lock.size).toBe(0);
  });
});

describe('0.3 configuration', () => {
  const VARS = [
    'SNITCH_UPLOAD_CHUNK_BYTES',
    'SNITCH_BACKUP_INTERVAL_HOURS',
    'SNITCH_BACKUP_KEEP',
    'SNITCH_BACKUP_S3_ENDPOINT',
    'SNITCH_BACKUP_S3_BUCKET',
    'SNITCH_BACKUP_S3_ACCESS_KEY_ID',
    'SNITCH_BACKUP_S3_SECRET_ACCESS_KEY',
    'SNITCH_BACKUP_S3_PREFIX',
    'SNITCH_GITHUB_CLIENT_ID',
    'SNITCH_GITHUB_CLIENT_SECRET',
    'SNITCH_GITHUB_ALLOWED_ORG',
    'SNITCH_GITHUB_AUTO_CREATE',
  ];
  const withEnv = (env: Record<string, string>) => {
    process.env.SNITCH_DATA_DIR = mkdtempSync(join(tmpdir(), 'snitch-cfg-'));
    process.env.SNITCH_SECRET_KEY = 'test-secret-key-that-is-long-enough-1234';
    for (const v of VARS) delete process.env[v];
    Object.assign(process.env, env);
    try {
      return loadConfig({ dbPath: ':memory:' });
    } finally {
      for (const v of VARS) delete process.env[v];
    }
  };

  it('defaults', () => {
    const c = withEnv({});
    expect(c.uploadChunkBytes).toBe(1024 * 1024);
    expect(c.backup).toEqual({ intervalHours: 0, keep: 7, s3: null, s3Prefix: 'snitch-backups/' });
    expect(c.githubAuth).toBeNull();
  });

  it('clamps the chunk size to the contract range', () => {
    expect(withEnv({ SNITCH_UPLOAD_CHUNK_BYTES: '10' }).uploadChunkBytes).toBe(CHUNK_BYTES_MIN);
    expect(withEnv({ SNITCH_UPLOAD_CHUNK_BYTES: String(1e12) }).uploadChunkBytes).toBe(CHUNK_BYTES_MAX);
    expect(withEnv({ SNITCH_UPLOAD_CHUNK_BYTES: '300000.5' }).uploadChunkBytes).toBe(300000);
  });

  it('reads an off-site backup bucket and insists on its credentials', () => {
    const c = withEnv({
      SNITCH_BACKUP_INTERVAL_HOURS: '12',
      SNITCH_BACKUP_S3_ENDPOINT: 'http://127.0.0.1:8333/',
      SNITCH_BACKUP_S3_BUCKET: 'bk',
      SNITCH_BACKUP_S3_ACCESS_KEY_ID: 'id',
      SNITCH_BACKUP_S3_SECRET_ACCESS_KEY: 'secret',
      SNITCH_BACKUP_S3_PREFIX: '/team/snitch',
    });
    expect(c.backup).toEqual({
      intervalHours: 12,
      keep: 7,
      s3: { endpoint: 'http://127.0.0.1:8333', region: 'auto', bucket: 'bk', accessKeyId: 'id', secretAccessKey: 'secret', forcePathStyle: true },
      s3Prefix: 'team/snitch/',
    });
    expect(() => withEnv({ SNITCH_BACKUP_S3_BUCKET: 'bk' })).toThrow(/SNITCH_BACKUP_S3_ENDPOINT is required/);
  });

  it('reads the GitHub OAuth app', () => {
    expect(withEnv({ SNITCH_GITHUB_CLIENT_ID: 'id', SNITCH_GITHUB_CLIENT_SECRET: 's', SNITCH_GITHUB_ALLOWED_ORG: 'mochiro', SNITCH_GITHUB_AUTO_CREATE: 'true' }).githubAuth).toEqual({
      clientId: 'id',
      clientSecret: 's',
      allowedOrg: 'mochiro',
      autoCreate: true,
      webUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
    });
    expect(() => withEnv({ SNITCH_GITHUB_CLIENT_ID: 'id' })).toThrow(/SNITCH_GITHUB_CLIENT_SECRET/);
  });

  it('names backups by UTC time', () => {
    expect(backupName(Date.parse('2026-10-07T12:34:56.789Z'))).toBe('snitch-20261007T123456Z.db.gz');
  });
});

describe('migration 2', () => {
  it('upgrades a 0.2 database in place', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS.slice(0, 1));
    db.prepare(
      "INSERT INTO projects (id, slug, name, ticket_prefix, report_types_json, allowed_release_types_json, created_at, updated_at) VALUES ('p', 'p', 'P', 'P', '[]', '[]', 1, 1)",
    ).run();
    db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u', 'a@b.c', 'x', 'admin', 1)").run();
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT notify_assignees, notify_reporters FROM projects').get()).toEqual({ notify_assignees: 1, notify_reporters: 0 });
    expect(db.prepare('SELECT github_id, github_login FROM users').get()).toEqual({ github_id: null, github_login: null });
    db.prepare("UPDATE users SET github_id = 1 WHERE id = 'u'").run();
    db.prepare("INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('v', 'v@b.c', 'x', 'member', 1)").run();
    expect(() => db.prepare("UPDATE users SET github_id = 1 WHERE id = 'v'").run()).toThrow(/UNIQUE/);
  });
});
