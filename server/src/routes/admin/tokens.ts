/**
 * Personal API tokens and device sign-in approval.
 *
 *   GET    /token                  who this token (or session) is
 *   DELETE /token                  a token revokes itself (`snitch logout`)
 *   GET    /tokens                 your tokens; ?all=true lists everyone's (admins)
 *   POST   /tokens                 make one; the token is in this response only
 *   DELETE /tokens/:id             revoke yours, or anyone's as an admin
 *   GET    /device/:userCode       a pending CLI sign-in, for the approval page
 *   POST   /device/:userCode/approve | /deny
 *
 * Only GET and DELETE /token accept a bearer token (http/apiAuth.ts): a token
 * can never mint, list or approve tokens.
 */
import { Hono } from 'hono';
import { ApiTokenCreate, type ApiTokenCreated, type DeviceCodeInfo, type WhoAmI } from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { forbidden, invalid, notFound } from '../../http/errors';
import { jsonBody } from '../../http/validate';
import { DEFAULT_TOKEN_DAYS, scopesOf, toApiTokenView } from '../../repo/apiTokens';
import { toUserView } from '../../repo/users';
import { VERSION } from '../../version';

export function tokenRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/token', (c) => {
    const t = c.get('apiToken');
    return c.json({
      user: toUserView(c.get('user')),
      token: t ? { id: t.id, name: t.name, scopes: scopesOf(t), expiresAt: t.expires_at } : null,
      server: { version: VERSION, publicUrl: deps.config.publicUrl },
    } satisfies WhoAmI);
  });

  app.delete('/token', (c) => {
    const t = c.get('apiToken');
    if (!t) throw invalid('This request has no API token to revoke');
    deps.apiTokens.revoke(t.id);
    deps.audit.add(t.user_id, 'api_token.revoked', t.id, { name: t.name, by: 'itself' }, c.get('ip'));
    return c.json({ ok: true });
  });

  app.get('/tokens', (c) => {
    const user = c.get('user');
    if (c.req.query('all') === 'true') {
      if (user.role !== 'admin') throw forbidden('Admins only');
      return c.json(deps.apiTokens.listAll());
    }
    return c.json(deps.apiTokens.listForUser(user.id));
  });

  app.post('/tokens', async (c) => {
    const user = c.get('user');
    const body = await jsonBody(c, ApiTokenCreate);
    const { token, row } = deps.apiTokens.create(user.id, { name: body.name, scopes: body.scopes, days: body.expiresInDays === undefined ? DEFAULT_TOKEN_DAYS : body.expiresInDays });
    deps.audit.add(user.id, 'api_token.created', row.id, { name: row.name, scopes: body.scopes, expiresAt: row.expires_at }, c.get('ip'));
    return c.json({ token, view: toApiTokenView(row) } satisfies ApiTokenCreated, 201);
  });

  app.delete('/tokens/:id', (c) => {
    const user = c.get('user');
    const row = deps.apiTokens.get(c.req.param('id'));
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw notFound('No such token');
    if (deps.apiTokens.revoke(row.id)) deps.audit.add(user.id, 'api_token.revoked', row.id, { name: row.name, owner: row.user_id }, c.get('ip'));
    return c.json({ ok: true });
  });

  // ── Device sign-in approval ──────────────────────────────────────────────

  const pending = (code: string) => {
    const row = deps.deviceCodes.byUserCode(code);
    if (!row) throw notFound('This code has expired or was already used. Run `snitch login` again for a new one.');
    return row;
  };

  app.get('/device/:userCode', (c) => c.json(deps.deviceCodes.info(pending(c.req.param('userCode')), c.get('ip')) satisfies DeviceCodeInfo));

  for (const decision of ['approve', 'deny'] as const) {
    app.post(`/device/:userCode/${decision}`, (c) => {
      const user = c.get('user');
      const row = pending(c.req.param('userCode'));
      if (!deps.deviceCodes.decide(row.user_code, user.id, decision === 'approve')) throw invalid('This sign-in was already approved or denied');
      deps.audit.add(user.id, decision === 'approve' ? 'device.approved' : 'device.denied', row.user_code, { clientName: row.client_name, ip: row.ip }, c.get('ip'));
      return c.json(deps.deviceCodes.info(deps.deviceCodes.byUserCode(row.user_code) ?? row, c.get('ip')) satisfies DeviceCodeInfo);
    });
  }

  return app;
}
