/**
 * ULIDs: 48-bit millisecond time + 80 random bits, Crockford base32. Sortable
 * by creation time, safe in URLs, no dependency.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + randomBase32(16);
}

/** `n` random Crockford base32 characters (5 bits each, from fresh random bytes). */
export function randomBase32(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i]! & 31];
  return out;
}
