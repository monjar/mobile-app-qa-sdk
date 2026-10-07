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
