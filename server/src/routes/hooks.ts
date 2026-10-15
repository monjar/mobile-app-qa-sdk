/**
 * Public, signed webhooks from the outside world (/api/hooks/*).
 *
 *   POST /api/hooks/github/:integrationId   issue, comment and pull request events for two-way sync
 *
 * GitHub signs the raw body with the integration's webhook secret
 * (X-Hub-Signature-256: sha256=HMAC_SHA256(secret, body)). Anything without a
 * valid signature is refused before the body is parsed. The integration id in
 * the URL only selects which secret to check.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHmac } from 'node:crypto';
import type { Deps } from '../deps';
import type { AppEnv } from '../http/env';
import { errorBody, invalid, unauthorized } from '../http/errors';
import { safeEqual } from '../crypto/tokens';
import { handleGithubEvent } from '../integrations/githubSync';
import { log } from '../log';

/** GitHub caps webhook payloads at 25 MB, but issue events are small; 1 MB is generous. */
export const HOOK_BODY_LIMIT = 1024 * 1024;

export function githubSignature(secret: string, body: Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function hookRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post(
    '/github/:integrationId',
    bodyLimit({ maxSize: HOOK_BODY_LIMIT, onError: (c) => c.json(errorBody('payload_too_large', 'Webhook body too large'), 413) }),
    async (c) => {
      deps.limiters.hooksPerIp.enforce(c.get('ip'));
      const integration = deps.integrations.get(c.req.param('integrationId'));
      const raw = Buffer.from(await c.req.arrayBuffer());
      const secret = integration?.kind === 'github' ? deps.integrations.webhookSecret(integration) : null;
      const sent = c.req.header('x-hub-signature-256') ?? '';
      if (!integration || !secret || !safeEqual(sent, githubSignature(secret, raw))) throw unauthorized('Missing or invalid X-Hub-Signature-256');

      const event = c.req.header('x-github-event') ?? '';
      if (event === 'ping') return c.body(null, 204);
      if (integration.enabled !== 1) return c.json({ handled: false, detail: 'integration is disabled' });

      // GitHub's "application/x-www-form-urlencoded" content type wraps the JSON in a `payload` field.
      const text = (c.req.header('content-type') ?? '').startsWith('application/x-www-form-urlencoded')
        ? (new URLSearchParams(raw.toString('utf8')).get('payload') ?? '')
        : raw.toString('utf8');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw invalid('Body is not valid JSON');
      }
      const result = handleGithubEvent(deps, integration, event, payload);
      log.info('hooks', 'github event', { integration: integration.id, event, delivery: c.req.header('x-github-delivery') ?? null, ...result });
      return c.json(result);
    },
  );

  return app;
}
