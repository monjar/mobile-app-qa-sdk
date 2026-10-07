/**
 * The caller's IP for rate limiting and audit. Proxy headers are only trusted
 * when SNITCH_TRUST_PROXY says which proxy sits in front: anyone can send
 * X-Forwarded-For to a server that's exposed directly.
 */
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { TrustProxy } from '../config';

export function clientIp(c: Context, trust: TrustProxy): string {
  const header = (name: string) => c.req.header(name)?.split(',')[0]?.trim();
  let ip: string | undefined;
  if (trust === 'fly') ip = header('fly-client-ip');
  else if (trust === 'cloudflare') ip = header('cf-connecting-ip');
  else if (trust === 'xff') ip = header('x-forwarded-for');
  if (ip) return ip;
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
