/**
 * Who is calling the admin API: a dashboard session (cookie + CSRF, session.ts)
 * or a personal API token (`Authorization: Bearer snitch_at_…`).
 *
 * Tokens only reach the routes listed in TOKEN_ROUTES, each behind a scope.
 * Anything else, including every route added later, refuses tokens until it's
 * listed here on purpose. Bearer requests skip the CSRF check: CSRF abuses
 * cookies the browser attaches by itself, and nothing attaches this header.
 */
import type { MiddlewareHandler } from 'hono';
import { ADMIN_PREFIX, API_TOKEN, type ApiTokenScope } from '@snitch/contract';
import type { Deps } from '../deps';
import { scopesOf } from '../repo/apiTokens';
import type { AppEnv } from './env';
import { forbidden, unauthorized } from './errors';
import { requireSession } from './session';

/** A ticket or attachment id (ULID), so a future sibling route like /tickets/export isn't matched by accident. */
const ID = '[0-9A-HJKMNP-TV-Z]{26}';

/** [methods, path under /api/admin, scope (null: any valid token)]. */
const TOKEN_ROUTES: readonly [readonly string[], RegExp, ApiTokenScope | null][] = [
  [['GET', 'DELETE'], /^\/token$/, null],
  [['GET'], /^\/projects$/, 'tickets:read'],
  [['GET'], /^\/tickets$/, 'tickets:read'],
  [['GET'], new RegExp(`^/tickets/${ID}$`), 'tickets:read'],
  [['GET', 'HEAD'], new RegExp(`^/attachments/${ID}/content$`), 'tickets:read'],
  [['PATCH'], new RegExp(`^/tickets/${ID}$`), 'tickets:write'],
  [['POST'], new RegExp(`^/tickets/${ID}/comments$`), 'tickets:write'],
];

/** The scope a token needs for this request; null for any token; undefined when tokens can't use it at all. */
export function tokenScopeFor(method: string, path: string): ApiTokenScope | null | undefined {
  const sub = path.startsWith(ADMIN_PREFIX) ? path.slice(ADMIN_PREFIX.length) : path;
  for (const [methods, re, scope] of TOKEN_ROUTES) if (methods.includes(method) && re.test(sub)) return scope;
  return undefined;
}

export function requireAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const session = requireSession(deps);
  return async (c, next) => {
    // Only a Bearer header means a token. Anything else (Basic auth added by a proxy in front of the
    // dashboard, say) is left alone and the session cookie decides, as before tokens existed.
    const header = c.req.header('authorization');
    if (header === undefined || !/^Bearer\s/i.test(header)) return session(c, next);

    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
    const found = bearer && API_TOKEN.test(bearer) ? deps.apiTokens.lookup(bearer) : null;
    if (!found) throw unauthorized('Invalid, expired or revoked API token');
    deps.limiters.apiPerToken.enforce(found.token.id, 'Too many requests for this API token; slow down');

    const method = c.req.method;
    const need = tokenScopeFor(method, c.req.path);
    if (need === undefined) throw forbidden('API tokens can’t use this endpoint; it needs a dashboard sign-in');
    if (need !== null && !scopesOf(found.token).includes(need)) throw forbidden(`This API token lacks the ${need} scope`);

    deps.apiTokens.touch(found.token, c.get('ip'));
    c.set('user', found.user);
    c.set('apiToken', found.token);
    await next();
    // Audited once it worked: a refused or failed write changed nothing. (Thrown errors skip this.)
    if (method !== 'GET' && method !== 'HEAD' && c.res.status < 400) {
      deps.audit.add(found.user.id, 'api_token.write', `${method} ${c.req.path}`, { tokenId: found.token.id, tokenName: found.token.name }, c.get('ip'));
    }
  };
}
