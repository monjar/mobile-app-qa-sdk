/**
 * Authenticates SDK requests by their public ingest key (X-Snitch-Key).
 * The key identifies a project and allows writing reports to it, nothing else.
 */
import type { MiddlewareHandler } from 'hono';
import { HEADERS, INGEST_KEY_PATTERN } from '@snitch/contract';
import type { Deps } from '../deps';
import { MINUTE_MS } from '../util/clock';
import type { AppEnv } from './env';
import { HttpError } from './errors';

export function ingestAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header(HEADERS.ingestKey)?.trim();
    if (!key || !INGEST_KEY_PATTERN.test(key)) throw new HttpError(401, 'unauthorized', 'Missing or malformed X-Snitch-Key');
    const auth = deps.projects.authenticate(key);
    if (!auth) throw new HttpError(401, 'unauthorized', 'Unknown or revoked ingest key');
    if (auth.lastUsedAt === null || deps.now() - auth.lastUsedAt > MINUTE_MS) deps.projects.touchKey(auth.keyId);
    c.set('project', auth.project);
    c.set('ingestKeyId', auth.keyId);
    await next();
  };
}
