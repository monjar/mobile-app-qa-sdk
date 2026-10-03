/**
 * SDK-facing routes (/api/v1): remote config, report intake, attachment upload.
 * See contract/src/ingest.ts for the protocol.
 */
import { Hono } from 'hono';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  HEADERS,
  ReportCreate,
  SdkConfigQuery,
  type AttachmentContentType,
  type ReportCreated,
} from '@snitch/contract';
import type { Deps } from '../deps';
import type { AppEnv } from '../http/env';
import { HttpError, notFound } from '../http/errors';
import { ingestAuth } from '../http/ingestAuth';
import { jsonBody, query } from '../http/validate';
import { magicMatches, streamToFile } from '../http/streamUpload';
import { attachmentKey } from '../storage/blobStore';
import { ticketKey, type TicketRow } from '../repo/tickets';
import { ulid } from '../util/ids';
import { enqueueRoute } from '../worker/worker';
import { log } from '../log';

export function ingestRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', ingestAuth(deps));

  app.get('/sdk/config', (c) => {
    deps.limiters.configPerIp.enforce(c.get('ip'));
    const q = query(c, SdkConfigQuery);
    const project = c.get('project');
    let config = deps.projects.effectiveSdkConfig(project, q.platform, q.releaseType);
    // A device reporting a capture crash loop gets video off until someone changes the config.
    if (q.health === 'crashloop') config = { ...config, video: { ...config.video, captureMode: 'off', enabled: false } };
    const body = JSON.stringify(config);
    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    c.header('ETag', etag);
    c.header('Cache-Control', 'private, no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.body(body, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  app.post('/reports', async (c) => {
    const project = c.get('project');
    deps.limiters.reportsPerKey.enforce(c.get('ingestKeyId'), 'Too many reports for this key');
    const report = await jsonBody(c, ReportCreate);

    const existing = deps.tickets.findByClientId(project.id, report.clientReportId);
    if (existing) return c.json(createdBody(deps, project.ticketPrefix, existing), 200);

    deps.limiters.reportsPerIp.enforce(c.get('ip'), 'Too many reports from this address');
    if (!project.allowedReleaseTypes.includes(report.app.releaseType)) {
      throw new HttpError(403, 'release_type_not_allowed', `Release type ${report.app.releaseType} is not accepted by this project`);
    }
    if (project.allowedAppIds && !project.allowedAppIds.includes(report.app.id)) {
      throw new HttpError(403, 'app_id_not_allowed', `App ${report.app.id} is not accepted by this project`);
    }
    const ticket = deps.tickets.createFromReport(project, report);
    log.info('ingest', 'report received', { project: project.slug, ticket: ticketKey(project.ticketPrefix, ticket.number), attachments: report.attachments.length });
    if (ticket.upload_state === 'complete') {
      enqueueRoute(deps, ticket.id);
      deps.wake();
    }
    return c.json(createdBody(deps, project.ticketPrefix, ticket), 201);
  });

  app.put('/reports/:id/attachments/:name', async (c) => {
    const project = c.get('project');
    const ticket = ownTicket(deps, project.id, c.req.param('id'));
    if (ticket.upload_state !== 'pending') throw new HttpError(409, 'report_completed', 'This report is already complete');
    const att = deps.tickets.attachment(ticket.id, c.req.param('name'));
    if (!att) throw notFound('No such attachment was declared for this report');

    const contentType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (contentType !== att.content_type) throw new HttpError(415, 'unsupported_media_type', `Expected ${att.content_type}`);
    const lengthHeader = c.req.header('content-length');
    if (!lengthHeader) throw new HttpError(411, 'length_required', 'Content-Length is required');
    const length = Number(lengthHeader);
    const cap = ATTACHMENT_LIMITS[att.content_type as AttachmentContentType] ?? 0;
    if (!Number.isInteger(length) || length > cap) throw new HttpError(413, 'payload_too_large', `At most ${cap} bytes`);
    if (length !== att.declared_size) throw new HttpError(422, 'invalid_request', `Declared ${att.declared_size} bytes, sending ${length}`);
    const sha = (c.req.header(HEADERS.contentSha256) ?? '').toLowerCase();
    if (sha !== att.declared_sha256) throw new HttpError(422, 'hash_mismatch', 'X-Content-SHA256 does not match the declared hash');

    if (att.state === 'stored') {
      if (att.sha256 === sha) return c.json({ name: att.name, state: 'stored' as const, sizeBytes: att.size_bytes ?? length }, 200);
      throw new HttpError(409, 'conflict', 'A different file was already stored under this name');
    }

    const tmpDir = join(deps.config.dataDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmp = join(tmpDir, `${ulid()}.part`);
    const file = await streamToFile(c.req.raw.body, tmp, att.declared_size);
    if (file.size !== att.declared_size) {
      await rm(tmp, { force: true });
      throw new HttpError(422, 'invalid_request', `Received ${file.size} of ${att.declared_size} bytes`);
    }
    if (file.sha256 !== att.declared_sha256) {
      await rm(tmp, { force: true });
      throw new HttpError(422, 'hash_mismatch', 'Body does not match X-Content-SHA256');
    }
    if (!magicMatches(att.content_type, file.head)) {
      await rm(tmp, { force: true });
      throw new HttpError(422, 'magic_mismatch', `Body is not a valid ${att.content_type}`);
    }
    const key = attachmentKey(project.id, ticket.id, att.id);
    await deps.blobs.putFile(key, tmp, att.content_type);
    deps.tickets.markStored(att.id, file.size, file.sha256, key);
    return c.json({ name: att.name, state: 'stored' as const, sizeBytes: file.size }, 201);
  });

  app.post('/reports/:id/complete', (c) => {
    const project = c.get('project');
    const ticket = ownTicket(deps, project.id, c.req.param('id'));
    if (ticket.upload_state === 'pending') {
      const missing = deps.tickets
        .attachments(ticket.id)
        .filter((a) => a.state === 'missing')
        .map((a) => a.name);
      if (missing.length) throw new HttpError(409, 'attachments_missing', 'Some declared attachments have not been uploaded', { missing });
      if (deps.tickets.complete(ticket.id)) {
        enqueueRoute(deps, ticket.id);
        deps.wake();
      }
    }
    const fresh = deps.tickets.get(ticket.id)!;
    return c.json({ reportId: fresh.id, ticket: ticketKey(project.ticketPrefix, fresh.number), state: fresh.upload_state }, 200);
  });

  return app;
}

function ownTicket(deps: Deps, projectId: string, id: string): TicketRow {
  const t = deps.tickets.get(id);
  if (!t || t.project_id !== projectId) throw notFound('No such report');
  return t;
}

function createdBody(deps: Deps, prefix: string, t: TicketRow): ReportCreated {
  return {
    reportId: t.id,
    ticket: ticketKey(prefix, t.number),
    number: t.number,
    state: t.upload_state,
    attachments: deps.tickets.attachments(t.id).map((a) => ({ name: a.name, state: a.state })),
  };
}
