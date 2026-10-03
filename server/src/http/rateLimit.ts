/**
 * In-memory fixed-window rate limiter. Single instance by design: Snitch runs as
 * one process, so a map is enough and survives nothing — limits reset on restart.
 */
import type { Clock } from '../util/clock';
import { HttpError } from './errors';

export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: Clock,
  ) {}

  /** Counts one hit; returns seconds until retry when over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || t - cur.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      return 0;
    }
    cur.count += 1;
    if (cur.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((cur.windowStart + this.windowMs - t) / 1000));
  }

  /** Throws 429 with Retry-After when over the limit. */
  enforce(key: string, message = 'Too many requests'): void {
    const retry = this.hit(key);
    if (retry > 0) throw new HttpError(429, 'rate_limited', message, undefined, { 'retry-after': String(retry) });
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}
