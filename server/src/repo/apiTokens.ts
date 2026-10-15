/**
 * Personal API tokens and the device sign-in that hands them to the CLI.
 *
 * Like sessions, only a token's SHA-256 is stored. A device code is a pending
 * sign-in: the CLI holds the random `deviceCode`, the user types the short
 * `userCode` into the dashboard and approves it, and the token is minted on
 * the CLI's next poll, so no plaintext token is ever written down.
 */
import { API_TOKEN_PREFIX, type ApiTokenScope, type ApiTokenView, type DeviceCodeInfo, type PersonRef } from '@snitch/contract';
import type { Db } from '../db/open';
import { randomBytes } from 'node:crypto';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { DAY_MS, MINUTE_MS, type Clock } from '../util/clock';
import { randomBase32, ulid } from '../util/ids';
import { parseJson, toJson } from '../util/json';
import type { UserRow } from './users';

export interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes_json: string;
  via_device: number;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
}

/** Characters after the prefix that the dashboard shows to tell tokens apart. */
const SHOWN_CHARS = 4;
/** last_used_at is written at most this often per token, so reads don't turn into writes. */
const TOUCH_EVERY_MS = MINUTE_MS;
export const DEFAULT_TOKEN_DAYS = 90;

export function generateApiToken(): string {
  return API_TOKEN_PREFIX + randomBase32(32);
}

export function scopesOf(row: Pick<ApiTokenRow, 'scopes_json'>): ApiTokenScope[] {
  return parseJson<ApiTokenScope[]>(row.scopes_json, []);
}

export function toApiTokenView(r: ApiTokenRow, user?: PersonRef): ApiTokenView {
  return {
    id: r.id,
    name: r.name,
    prefix: `${r.token_prefix}…`,
    scopes: scopesOf(r),
    viaDevice: r.via_device === 1,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastUsedAt: r.last_used_at,
    lastUsedIp: r.last_used_ip,
    revokedAt: r.revoked_at,
    ...(user ? { user } : {}),
  };
}

export class ApiTokensRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /** `days: null` never expires. */
  create(userId: string, input: { name: string; scopes: ApiTokenScope[]; days: number | null; viaDevice?: boolean }): { token: string; row: ApiTokenRow } {
    const t = this.now();
    const token = generateApiToken();
    const id = ulid(t);
    this.db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scopes_json, via_device, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        sha256Hex(token),
        token.slice(0, API_TOKEN_PREFIX.length + SHOWN_CHARS),
        toJson(input.scopes),
        input.viaDevice ? 1 : 0,
        t,
        input.days === null ? null : t + input.days * DAY_MS,
      );
    return { token, row: this.get(id)! };
  }

  get(id: string): ApiTokenRow | null {
    return (this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as ApiTokenRow | undefined) ?? null;
  }

  /** The live token and its (enabled) user, or null if unknown, revoked, expired or the user is disabled. */
  lookup(token: string): { token: ApiTokenRow; user: UserRow } | null {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(sha256Hex(token)) as ApiTokenRow | undefined;
    if (!row || row.revoked_at !== null || (row.expires_at !== null && row.expires_at <= this.now())) return null;
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
    if (!user || user.disabled_at !== null) return null;
    return { token: row, user };
  }

  /** Records a use, at most once a minute per token. */
  touch(row: ApiTokenRow, ip: string | null): void {
    const t = this.now();
    if (row.last_used_at !== null && t - row.last_used_at < TOUCH_EVERY_MS && row.last_used_ip === ip) return;
    this.db.prepare('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(t, ip, row.id);
  }

  /** A user's tokens, newest first, revoked ones included (the page shows them struck through). */
  listForUser(userId: string): ApiTokenView[] {
    return (this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC').all(userId) as ApiTokenRow[]).map((r) => toApiTokenView(r));
  }

  /** Every user's live tokens, for admins. */
  listAll(): ApiTokenView[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, u.email AS u_email, u.name AS u_name FROM api_tokens t JOIN users u ON u.id = t.user_id
         WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) ORDER BY t.created_at DESC, t.rowid DESC`,
      )
      .all(this.now()) as (ApiTokenRow & { u_email: string; u_name: string | null })[];
    return rows.map((r) => toApiTokenView(r, { id: r.user_id, email: r.u_email, name: r.u_name }));
  }

  /** False when it was already revoked. */
  revoke(id: string): boolean {
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.now(), id).changes > 0;
  }

  revokeForUser(userId: string): number {
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.now(), userId).changes;
  }
}

// ── Device sign-in ─────────────────────────────────────────────────────────

/** No vowels (no words), no lookalikes beyond what Crockford already drops. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const DEVICE_CODE_TTL_MS = 10 * MINUTE_MS;
export const DEVICE_POLL_INTERVAL_S = 5;

export interface DeviceCodeRow {
  device_code_hash: string;
  user_code: string;
  client_name: string;
  scopes_json: string;
  token_days: number | null;
  ip: string | null;
  created_at: number;
  expires_at: number;
  interval_s: number;
  last_polled_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  denied_at: number | null;
  token_id: string | null;
}

/** "bcdf-ghjk", "BCDFGHJK" → "BCDF-GHJK". */
export function normalizeUserCode(code: string): string {
  const c = code.toUpperCase().replace(/[^A-Z]/g, '');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}`;
}

function randomUserCode(): string {
  let out = '';
  while (out.length < 8) {
    // Rejection sampling: bytes 240–255 would favour the first letters.
    for (const b of randomBytes(16)) {
      if (b < 240 && out.length < 8) out += USER_CODE_ALPHABET[b % 20];
    }
  }
  return normalizeUserCode(out);
}

export type PollResult<T> = { status: 'pending' | 'slow_down' | 'denied' | 'expired' } | { status: 'approved'; minted: T };

export interface ApprovedRequest {
  userId: string;
  clientName: string;
  scopes: ApiTokenScope[];
  days: number | null;
}

export class DeviceCodesRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(input: { clientName: string; scopes: ApiTokenScope[]; days: number | null; ip: string | null }): { deviceCode: string; userCode: string; expiresAt: number; interval: number } {
    const t = this.now();
    const deviceCode = randomToken(32);
    const expiresAt = t + DEVICE_CODE_TTL_MS;
    for (let attempt = 0; ; attempt++) {
      const userCode = randomUserCode();
      try {
        this.db
          .prepare(
            `INSERT INTO device_codes (device_code_hash, user_code, client_name, scopes_json, token_days, ip, created_at, expires_at, interval_s)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(sha256Hex(deviceCode), userCode, input.clientName, toJson(input.scopes), input.days, input.ip, t, expiresAt, DEVICE_POLL_INTERVAL_S);
        return { deviceCode, userCode, expiresAt, interval: DEVICE_POLL_INTERVAL_S };
      } catch (e) {
        // A user code that's already pending: draw another (25.6 billion codes, so this is rare).
        if (attempt > 5 || !String((e as Error).message).includes('UNIQUE')) throw e;
      }
    }
  }

  /** The pending or decided request behind a user code, unless it expired or was already used. */
  byUserCode(userCode: string): DeviceCodeRow | null {
    const row = this.db.prepare('SELECT * FROM device_codes WHERE user_code = ?').get(normalizeUserCode(userCode)) as DeviceCodeRow | undefined;
    return row && row.expires_at > this.now() && row.token_id === null ? row : null;
  }

  info(row: DeviceCodeRow, viewerIp: string | null): DeviceCodeInfo {
    return {
      userCode: row.user_code,
      clientName: row.client_name,
      scopes: parseJson<ApiTokenScope[]>(row.scopes_json, []),
      tokenDays: row.token_days,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ip: row.ip,
      fromYourAddress: row.ip !== null && row.ip === viewerIp,
      state: row.denied_at !== null ? 'denied' : row.approved_at !== null ? 'approved' : 'pending',
    };
  }

  /** Approve or deny a still-pending code. False if it was decided already. */
  decide(userCode: string, userId: string, approve: boolean): boolean {
    const t = this.now();
    const sql = approve
      ? 'UPDATE device_codes SET approved_by = ?, approved_at = ? WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?'
      : 'UPDATE device_codes SET approved_by = ?, denied_at = ? WHERE user_code = ? AND approved_at IS NULL AND denied_at IS NULL AND expires_at > ?';
    return this.db.prepare(sql).run(userId, t, normalizeUserCode(userCode), t).changes > 0;
  }

  /**
   * One poll from the CLI. On the first poll after approval `mint` creates the
   * token in the same transaction that spends the code, so it's handed out
   * exactly once.
   */
  poll<T extends { tokenId: string }>(deviceCode: string, mint: (req: ApprovedRequest) => T): PollResult<T> {
    const t = this.now();
    const hash = sha256Hex(deviceCode);
    return this.db.transaction((): PollResult<T> => {
      const row = this.db.prepare('SELECT * FROM device_codes WHERE device_code_hash = ?').get(hash) as DeviceCodeRow | undefined;
      if (!row || row.token_id !== null) return { status: 'expired' };
      if (row.expires_at <= t) {
        this.db.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').run(hash);
        return { status: 'expired' };
      }
      if (row.denied_at !== null) {
        this.db.prepare('DELETE FROM device_codes WHERE device_code_hash = ?').run(hash);
        return { status: 'denied' };
      }
      // A second of slack for timers that fire a little early.
      if (row.last_polled_at !== null && t - row.last_polled_at < row.interval_s * 1000 - 1000) {
        this.db.prepare('UPDATE device_codes SET last_polled_at = ?, interval_s = interval_s + 5 WHERE device_code_hash = ?').run(t, hash);
        return { status: 'slow_down' };
      }
      this.db.prepare('UPDATE device_codes SET last_polled_at = ? WHERE device_code_hash = ?').run(t, hash);
      if (row.approved_at === null || row.approved_by === null) return { status: 'pending' };
      const minted = mint({ userId: row.approved_by, clientName: row.client_name, scopes: parseJson<ApiTokenScope[]>(row.scopes_json, []), days: row.token_days });
      this.db.prepare('UPDATE device_codes SET token_id = ? WHERE device_code_hash = ?').run(minted.tokenId, hash);
      return { status: 'approved', minted };
    })();
  }

  /** Expired requests, and spent ones (an hour later, so the dashboard can still say "approved"). */
  purgeExpired(): number {
    return this.db.prepare('DELETE FROM device_codes WHERE expires_at <= ?').run(this.now() - 60 * MINUTE_MS).changes;
  }
}
