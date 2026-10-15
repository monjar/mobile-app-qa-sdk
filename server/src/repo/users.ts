/**
 * Dashboard users, their sessions, and the admin audit log.
 *
 * Sessions are opaque random tokens; only their SHA-256 is stored, so a
 * database leak doesn't hand out live sessions. Expiry slides: each use more
 * than an hour after the last extension pushes it out by the full lifetime.
 */
import type { AccountTokenPurpose, AuditEntryView, UserRole, UserView } from '@snitch/contract';
import type { Db } from '../db/open';
import { hashPassword } from '../crypto/passwords';
import { randomToken, sha256Hex } from '../crypto/tokens';
import { DAY_MS, HOUR_MS, type Clock } from '../util/clock';
import { ulid } from '../util/ids';
import { parseJson, toJson } from '../util/json';

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string;
  role: UserRole;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
  /** Linked GitHub account (Sign in with GitHub). */
  github_id: number | null;
  github_login: string | null;
}

export function toUserView(r: UserRow): UserView {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    disabled: r.disabled_at !== null,
    pending: r.password_hash === INVITED,
  };
}

/** The password hash of an invited user who hasn't chosen one yet; verifyPassword never accepts it. */
export const INVITED = '';

export class UsersRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  async create(input: { email: string; name?: string | null; role: UserRole; password: string }): Promise<UserView> {
    const t = this.now();
    const id = ulid(t);
    const hash = await hashPassword(input.password);
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.email.trim(), input.name ?? null, hash, input.role, t);
    return this.view(id)!;
  }

  /** An invited user: no password until they follow their invite link. */
  createInvited(input: { email: string; name?: string | null; role: UserRole }): UserView {
    const t = this.now();
    const id = ulid(t);
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.email.trim(), input.name ?? null, INVITED, input.role, t);
    return this.view(id)!;
  }

  get(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  getByEmail(email: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined) ?? null;
  }

  getByGithubId(githubId: number): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as UserRow | undefined) ?? null;
  }

  linkGithub(id: string, githubId: number, login: string): void {
    this.db.prepare('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?').run(githubId, login, id);
  }

  view(id: string): UserView | null {
    const r = this.get(id);
    return r ? toUserView(r) : null;
  }

  list(): UserView[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toUserView);
  }

  activeAdminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get() as { n: number }).n;
  }

  async update(id: string, patch: { name?: string | null; role?: UserRole; disabled?: boolean; password?: string }): Promise<UserView | null> {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.role !== undefined) (sets.push('role = ?'), args.push(patch.role));
    if (patch.disabled !== undefined) (sets.push('disabled_at = ?'), args.push(patch.disabled ? this.now() : null));
    if (patch.password !== undefined) (sets.push('password_hash = ?'), args.push(await hashPassword(patch.password)));
    if (sets.length > 0) {
      args.push(id);
      this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    return this.view(id);
  }

  recordLogin(id: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now(), id);
  }
}

export interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export class SessionsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
    private readonly lifetimeMs: number,
  ) {}

  create(userId: string, ip: string | null, userAgent: string | null): { token: string; csrfToken: string; expiresAt: number } {
    const t = this.now();
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = t + this.lifetimeMs;
    this.db
      .prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(token), userId, csrfToken, t, expiresAt, t, ip, userAgent?.slice(0, 300) ?? null);
    return { token, csrfToken, expiresAt };
  }

  /** The live session and its (enabled) user for a cookie token, extending the expiry when due. */
  lookup(token: string): { session: SessionRow; user: UserRow } | null {
    const t = this.now();
    const idHash = sha256Hex(token);
    const row = this.db
      .prepare(
        `SELECT s.id_hash, s.user_id, s.csrf_token, s.created_at AS s_created_at, s.expires_at, s.last_seen_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .get(idHash) as (UserRow & SessionRow & { s_created_at: number }) | undefined;
    if (!row) return null;
    if (row.expires_at <= t || row.disabled_at !== null) {
      this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    if (t - row.last_seen_at > HOUR_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?').run(t, t + this.lifetimeMs, idHash);
    }
    return {
      session: { id_hash: idHash, user_id: row.user_id, csrf_token: row.csrf_token, created_at: row.s_created_at, expires_at: row.expires_at, last_seen_at: row.last_seen_at },
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        password_hash: row.password_hash,
        role: row.role,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
        disabled_at: row.disabled_at,
        github_id: row.github_id,
        github_login: row.github_login,
      },
    };
  }

  delete(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(token));
  }

  deleteForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes;
  }
}

export const SESSION_DAY = DAY_MS;

export interface AccountTokenRow {
  id_hash: string;
  user_id: string;
  purpose: AccountTokenPurpose;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/**
 * One-time links to choose a password (invites, resets). Like sessions, only
 * the token's SHA-256 is stored. A new link for the same user and purpose
 * replaces the old one, and using any link spends every other link the user has.
 */
export class AccountTokensRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(userId: string, purpose: AccountTokenPurpose, ttlMs: number, createdBy: string | null): { token: string; expiresAt: number } {
    const t = this.now();
    const token = randomToken(32);
    const expiresAt = t + ttlMs;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM account_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose);
      this.db
        .prepare('INSERT INTO account_tokens (id_hash, user_id, purpose, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sha256Hex(token), userId, purpose, createdBy, t, expiresAt);
    })();
    return { token, expiresAt };
  }

  /** The unused, unexpired link for `token`, with its user. */
  lookup(token: string): { row: AccountTokenRow; user: UserRow } | null {
    const row = this.db.prepare('SELECT * FROM account_tokens WHERE id_hash = ?').get(sha256Hex(token)) as AccountTokenRow | undefined;
    if (!row || row.used_at !== null || row.expires_at <= this.now()) return null;
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined;
    return user ? { row, user } : null;
  }

  /** Marks `token` used and drops the user's other open links. False if it was already spent (a race). */
  consume(token: string): boolean {
    const idHash = sha256Hex(token);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT user_id FROM account_tokens WHERE id_hash = ? AND used_at IS NULL').get(idHash) as { user_id: string } | undefined;
      if (!row) return false;
      this.db.prepare('UPDATE account_tokens SET used_at = ? WHERE id_hash = ?').run(this.now(), idHash);
      this.db.prepare('DELETE FROM account_tokens WHERE user_id = ? AND used_at IS NULL').run(row.user_id);
      return true;
    })();
  }

  purgeExpired(): number {
    return this.db.prepare('DELETE FROM account_tokens WHERE expires_at <= ?').run(this.now() - DAY_MS).changes;
  }
}

export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  add(userId: string | null, action: string, target: string | null, data: Record<string, unknown> = {}, ip: string | null = null): void {
    this.db
      .prepare('INSERT INTO audit_log (user_id, action, target, data_json, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, action, target, toJson(data), ip, this.now());
  }

  list(limit = 200, before?: number): AuditEntryView[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, u.email AS u_email, u.name AS u_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
         WHERE (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT ?`,
      )
      .all(before ?? null, before ?? null, limit) as {
      id: number;
      user_id: string | null;
      u_email: string | null;
      u_name: string | null;
      action: string;
      target: string | null;
      data_json: string;
      ip: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      user: r.user_id && r.u_email ? { id: r.user_id, email: r.u_email, name: r.u_name } : null,
      action: r.action,
      target: r.target,
      data: parseJson(r.data_json, {}),
      ip: r.ip,
      createdAt: r.created_at,
    }));
  }
}
