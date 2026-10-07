/**
 * Durable job queue in SQLite. A job is claimed by flipping it to `running`
 * in a single UPDATE … RETURNING, so a crash mid-job leaves it `running`;
 * `recoverStale` puts those back in the queue on boot.
 *
 * Retries back off exponentially (30 s · 2^attempts, capped at 6 h). After
 * max_attempts the job is `dead`: visible in the dashboard and retryable by hand.
 */
import type { JobState, JobView } from '@snitch/contract';
import type { Db } from '../db/open';
import type { Clock } from '../util/clock';
import { parseJson, toJson } from '../util/json';

export interface JobRow {
  id: number;
  kind: string;
  payload_json: string;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_at: number;
  locked_at: number | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export class JobsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  /** Enqueues a job. With a dedupe key, a second enqueue of the same key is ignored (returns null). */
  enqueue(kind: string, payload: Record<string, unknown>, opts: { runAt?: number; dedupeKey?: string; maxAttempts?: number } = {}): number | null {
    const t = this.now();
    const r = this.db
      .prepare(
        `INSERT INTO jobs (kind, payload_json, run_at, dedupe_key, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .run(kind, toJson(payload), opts.runAt ?? t, opts.dedupeKey ?? null, opts.maxAttempts ?? 8, t, t);
    return r.changes ? Number(r.lastInsertRowid) : null;
  }

  claim(): JobRow | null {
    const t = this.now();
    return (
      (this.db
        .prepare(
          `UPDATE jobs SET state = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1)
           RETURNING *`,
        )
        .get(t, t, t) as JobRow | undefined) ?? null
    );
  }

  succeed(id: number): void {
    this.db.prepare("UPDATE jobs SET state = 'done', locked_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /** Records a failure; returns true if the job is now dead. */
  fail(job: JobRow, error: string, retryAfterMs?: number): boolean {
    const t = this.now();
    const dead = job.attempts >= job.max_attempts;
    this.db
      .prepare('UPDATE jobs SET state = ?, locked_at = NULL, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?')
      .run(dead ? 'dead' : 'queued', error.slice(0, 2000), t + (retryAfterMs ?? backoffMs(job.attempts)), t, job.id);
    return dead;
  }

  recoverStale(olderThanMs: number): number {
    const t = this.now();
    return this.db
      .prepare("UPDATE jobs SET state = 'queued', locked_at = NULL, updated_at = ? WHERE state = 'running' AND locked_at < ?")
      .run(t, t - olderThanMs).changes;
  }

  retry(id: number): boolean {
    const t = this.now();
    return (
      this.db
        .prepare("UPDATE jobs SET state = 'queued', attempts = 0, run_at = ?, updated_at = ? WHERE id = ? AND state IN ('dead','queued')")
        .run(t, t, id).changes > 0
    );
  }

  get(id: number): JobRow | null {
    return (this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined) ?? null;
  }

  list(state: JobState | null, limit = 100): JobView[] {
    const rows = (
      state
        ? this.db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY updated_at DESC LIMIT ?').all(state, limit)
        : this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?').all(limit)
    ) as JobRow[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      runAt: r.run_at,
      lastError: r.last_error,
      payload: parseJson(r.payload_json, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Deletes finished jobs older than `olderThanMs` (dead ones are kept for inspection). */
  prune(olderThanMs: number): number {
    return this.db.prepare("DELETE FROM jobs WHERE state = 'done' AND updated_at < ?").run(this.now() - olderThanMs).changes;
  }
}
