/**
 * Project settings: projects, ingest keys, remote SDK config, integrations and
 * routing rules. Creating and changing these is admin-only; members can read.
 */
import { Hono } from 'hono';
import {
  EmailConfig,
  GithubConfig,
  IngestKeyCreate,
  IntegrationCreate,
  IntegrationUpdate,
  ProjectCreate,
  ProjectUpdate,
  RoutingRules,
  SdkConfigEntries,
  WebhookConfig,
  type IngestKeyCreated,
  type SdkConfigView,
} from '@snitch/contract';
import type { Deps } from '../../deps';
import type { AppEnv } from '../../http/env';
import { conflict, HttpError, invalid, notFound } from '../../http/errors';
import { requireAdmin } from '../../http/session';
import { jsonBody } from '../../http/validate';
import type { Project } from '../../repo/projects';
import * as integrations from '../../integrations';
import { SendError } from '../../integrations';
import { errorMessage } from '../../log';

function getProject(deps: Deps, id: string): Project {
  const p = deps.projects.get(id);
  if (!p) throw notFound('No such project');
  return p;
}

const CONFIG_SCHEMAS = { github: GithubConfig, email: EmailConfig, webhook: WebhookConfig } as const;

export function projectRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const admin = requireAdmin();

  app.get('/projects', (c) => c.json(deps.projects.list()));

  app.post('/projects', admin, async (c) => {
    const body = await jsonBody(c, ProjectCreate);
    if (deps.projects.getBySlug(body.slug)) throw conflict(`A project with slug "${body.slug}" already exists`);
    const project = deps.projects.create(body);
    const key = deps.projects.createKey(project.id, 'default');
    deps.audit.add(c.get('user').id, 'project.created', project.id, { slug: project.slug }, c.get('ip'));
    return c.json({ project: deps.projects.view(project.id), key }, 201);
  });

  app.get('/projects/:id', (c) => c.json(deps.projects.view(getProject(deps, c.req.param('id')).id)));

  app.patch('/projects/:id', admin, async (c) => {
    const p = getProject(deps, c.req.param('id'));
    const patch = await jsonBody(c, ProjectUpdate);
    if (patch.reportTypes && new Set(patch.reportTypes.map((r) => r.id)).size !== patch.reportTypes.length) throw invalid('Report type ids must be unique');
    deps.projects.update(p.id, patch);
    deps.audit.add(c.get('user').id, 'project.updated', p.id, { fields: Object.keys(patch) }, c.get('ip'));
    return c.json(deps.projects.view(p.id));
  });

  // ── Keys ─────────────────────────────────────────────────────────────────

  app.get('/projects/:id/keys', (c) => c.json(deps.projects.listKeys(getProject(deps, c.req.param('id')).id)));

  app.post('/projects/:id/keys', admin, async (c) => {
    const p = getProject(deps, c.req.param('id'));
    const body = await jsonBody(c, IngestKeyCreate);
    const created = deps.projects.createKey(p.id, body.label ?? null);
    deps.audit.add(c.get('user').id, 'key.created', created.key.id, { project: p.slug }, c.get('ip'));
    return c.json(created satisfies IngestKeyCreated, 201);
  });

  app.delete('/keys/:id', admin, (c) => {
    const id = c.req.param('id');
    if (!deps.projects.keyView(id)) throw notFound('No such key');
    deps.projects.revokeKey(id);
    deps.audit.add(c.get('user').id, 'key.revoked', id, {}, c.get('ip'));
    return c.json({ ok: true });
  });

  // ── Remote SDK config ────────────────────────────────────────────────────

  const sdkView = (p: Project): SdkConfigView => ({ entries: deps.projects.sdkConfigEntries(p.id), effective: deps.projects.effectiveMatrix(p) });

  app.get('/projects/:id/sdk-config', (c) => c.json(sdkView(getProject(deps, c.req.param('id')))));

  app.put('/projects/:id/sdk-config', admin, async (c) => {
    const p = getProject(deps, c.req.param('id'));
    const { entries } = await jsonBody(c, SdkConfigEntries);
    const keys = entries.map((e) => `${e.platform}/${e.releaseType}`);
    if (new Set(keys).size !== keys.length) throw invalid('Each platform/release type pair may appear once');
    deps.projects.replaceSdkConfig(p.id, entries);
    deps.audit.add(c.get('user').id, 'sdk_config.updated', p.id, { entries: entries.length }, c.get('ip'));
    return c.json(sdkView(p));
  });

  // ── Integrations ─────────────────────────────────────────────────────────

  app.get('/projects/:id/integrations', (c) => c.json(deps.integrations.list(getProject(deps, c.req.param('id')).id)));

  app.post('/projects/:id/integrations', admin, async (c) => {
    const p = getProject(deps, c.req.param('id'));
    const body = await jsonBody(c, IntegrationCreate);
    const secret = 'secret' in body ? (body.secret ?? null) : null;
    const view = deps.integrations.create(p.id, body.kind, body.name, body.config, secret);
    deps.audit.add(c.get('user').id, 'integration.created', view.id, { kind: view.kind, name: view.name }, c.get('ip'));
    return c.json(view, 201);
  });

  app.patch('/integrations/:id', admin, async (c) => {
    const row = deps.integrations.get(c.req.param('id'));
    if (!row) throw notFound('No such integration');
    const patch = await jsonBody(c, IntegrationUpdate);
    let config: unknown;
    if (patch.config !== undefined) {
      const parsed = CONFIG_SCHEMAS[row.kind].safeParse(patch.config);
      if (!parsed.success) throw invalid('Integration config failed validation', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      config = parsed.data;
    }
    const view = deps.integrations.update(row.id, { name: patch.name, config, secret: patch.secret, enabled: patch.enabled });
    deps.audit.add(c.get('user').id, 'integration.updated', row.id, { fields: Object.keys(patch).filter((k) => k !== 'secret'), secretChanged: patch.secret !== undefined }, c.get('ip'));
    return c.json(view);
  });

  app.delete('/integrations/:id', admin, (c) => {
    const row = deps.integrations.get(c.req.param('id'));
    if (!row) throw notFound('No such integration');
    deps.integrations.delete(row.id);
    deps.audit.add(c.get('user').id, 'integration.deleted', row.id, { name: row.name }, c.get('ip'));
    return c.json({ ok: true });
  });

  app.post('/integrations/:id/test', admin, async (c) => {
    const row = deps.integrations.get(c.req.param('id'));
    if (!row) throw notFound('No such integration');
    try {
      const message = await integrations.test(deps, row);
      return c.json({ ok: true, message });
    } catch (e) {
      const message = e instanceof SendError ? e.message : errorMessage(e);
      throw new HttpError(422, 'invalid_request', message);
    }
  });

  // ── Routing ──────────────────────────────────────────────────────────────

  app.get('/projects/:id/routing', (c) => c.json({ rules: deps.integrations.rules(getProject(deps, c.req.param('id')).id) }));

  app.put('/projects/:id/routing', admin, async (c) => {
    const p = getProject(deps, c.req.param('id'));
    const { rules } = await jsonBody(c, RoutingRules);
    const known = new Set(deps.integrations.list(p.id).map((i) => i.id));
    for (const r of rules) if (!known.has(r.integrationId)) throw invalid(`Unknown integration ${r.integrationId}`);
    const views = deps.integrations.replaceRules(p.id, rules);
    deps.audit.add(c.get('user').id, 'routing.updated', p.id, { rules: rules.length }, c.get('ip'));
    return c.json({ rules: views });
  });

  return app;
}
