/**
 * SDK-facing routes (/api/v1): remote config, report intake, attachment upload.
 * See contract/src/ingest.ts for the protocol, including chunked uploads.
 */
import { Hono, type Context } from 'hono';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  ATTACHMENT_LIMITS,
  CHUNK_BYTES_MAX,
  HEADERS,
  parseContentRange,
  ReportCreate,
  SdkConfigQuery,
  SERVER_FEATURES,
  type AttachmentContentType,
  type AttachmentPartial,
  type AttachmentStored,
  type ReportCreated,
} from '@snitch/contract';
import type { Deps } from '../deps';
import type { AppEnv } from '../http/env';
import { HttpError, invalid, notFound } from '../http/errors';
import { ingestAuth } from '../http/ingestAuth';
import { jsonBody, query } from '../http/validate';
import { appendFileTo, hashFile, magicMatches, streamToFile, type StreamedFile } from '../http/streamUpload';
import { attachmentKey } from '../storage/blobStore';
import { fileSize, partialDir, partialPath, tmpDir } from '../storage/partials';
import type { Project } from '../repo/projects';
import { ticketKey, type AttachmentRow, type TicketRow } from '../repo/tickets';
import { KeyedLock } from '../util/keyedLock';
import { ulid } from '../util/ids';
import { enqueueRoute } from '../worker/worker';
import { log } from '../log';

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function ingestRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', ingestAuth(deps));
  // Requests for the same attachment run one at a time: chunks append to one partial file.
  const locks = new KeyedLock();

  app.get('/sdk/config', (c) => {
    deps.limiters.configPerIp.enforce(c.get('ip'));
    const q = query(c, SdkConfigQuery);
    const project = c.get('project');
    let config = deps.projects.effectiveSdkConfig(project, q.platform, q.releaseType);
    // A device reporting a capture crash loop gets video off until someone changes the config.
    if (q.health === 'crashloop') config = { ...config, video: { ...config.video, captureMode: 'off', enabled: false } };
    if (q.installId) deps.installs.checkin(project.id, { ...q, installId: q.installId }, config.enabled);
    // Features describe this server, not the project, so they're added here and never stored.
    const body = JSON.stringify({ ...config, features: [...SERVER_FEATURES] });
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
    if (existing) return c.json(await createdBody(deps, project.ticketPrefix, existing), 200);

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
    return c.json(await createdBody(deps, project.ticketPrefix, ticket), 201);
  });

  // Attachment PUTs are not rate limited: their number and size are bounded by
  // the declared attachments of reports, which are.
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
    const sha = (c.req.header(HEADERS.contentSha256) ?? '').toLowerCase();

    const rangeHeader = c.req.header('content-range');
    if (rangeHeader !== undefined) return putChunk(c, project, ticket, att, rangeHeader, length, sha);

    if (length !== att.declared_size) throw new HttpError(422, 'invalid_request', `Declared ${att.declared_size} bytes, sending ${length}`);
    if (sha !== att.declared_sha256) throw new HttpError(422, 'hash_mismatch', 'X-Content-SHA256 does not match the declared hash');
    if (att.state === 'stored') return alreadyStored(c, att, sha);

    return locks.run(att.id, async () => {
      const cur = deps.tickets.attachment(ticket.id, att.name);
      if (!cur) throw notFound('No such attachment was declared for this report');
      if (cur.state === 'stored') return alreadyStored(c, cur, sha);
      // A whole-file PUT replaces whatever a chunked upload left behind.
      await rm(partialPath(deps.config.dataDir, cur.id), { force: true });
      if (cur.received_bytes !== 0) deps.tickets.setReceivedBytes(cur.id, 0);

      const dir = tmpDir(deps.config.dataDir);
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${ulid()}.part`);
      const file = await streamToFile(c.req.raw.body, tmp, cur.declared_size);
      if (file.size !== cur.declared_size) {
        await rm(tmp, { force: true });
        throw new HttpError(422, 'invalid_request', `Received ${file.size} of ${cur.declared_size} bytes`);
      }
      if (file.sha256 !== cur.declared_sha256) {
        await rm(tmp, { force: true });
        throw new HttpError(422, 'hash_mismatch', 'Body does not match X-Content-SHA256');
      }
      if (!magicMatches(cur.content_type, file.head)) {
        await rm(tmp, { force: true });
        throw new HttpError(422, 'magic_mismatch', `Body is not a valid ${cur.content_type}`);
      }
      return store(c, project, ticket, cur, tmp, file);
    });
  });

  /**
   * One Content-Range chunk. Bytes go to a temp file first and are appended to
   * the partial file only once complete (and matching X-Chunk-SHA256 when
   * sent), so an interrupted request never leaves half a chunk behind.
   */
  async function putChunk(c: Context<AppEnv>, project: Project, ticket: TicketRow, att: AttachmentRow, rangeHeader: string, length: number, sha: string) {
    const range = parseContentRange(rangeHeader);
    if (!range) throw invalid('Content-Range must look like "bytes <start>-<end>/<total>"');
    if (range.total !== att.declared_size) throw invalid(`Declared ${att.declared_size} bytes, Content-Range says ${range.total}`);
    const chunkBytes = range.end - range.start + 1;
    if (length !== chunkBytes) throw invalid(`Content-Range covers ${chunkBytes} bytes, Content-Length says ${length}`);
    if (chunkBytes > CHUNK_BYTES_MAX) throw new HttpError(413, 'payload_too_large', `Chunks are at most ${CHUNK_BYTES_MAX} bytes`);
    if (sha !== att.declared_sha256) throw new HttpError(422, 'hash_mismatch', 'X-Content-SHA256 does not match the declared hash');
    const chunkSha = c.req.header(HEADERS.chunkSha256)?.trim().toLowerCase();
    if (chunkSha !== undefined && !SHA256_HEX.test(chunkSha)) throw invalid('X-Chunk-SHA256 must be 64 hex characters');
    if (att.state === 'stored') return alreadyStored(c, att, sha);

    return locks.run(att.id, async () => {
      const cur = deps.tickets.attachment(ticket.id, att.name);
      if (!cur) throw notFound('No such attachment was declared for this report');
      if (cur.state === 'stored') return alreadyStored(c, cur, sha);
      const part = partialPath(deps.config.dataDir, cur.id);
      let received = await fileSize(part);
      if (received > cur.declared_size) {
        await rm(part, { force: true });
        received = 0;
      }
      if (received !== cur.received_bytes) deps.tickets.setReceivedBytes(cur.id, received);
      // Every byte arrived before (the answer to the last chunk was lost, or the server stopped
      // before verifying): verify now rather than asking for a chunk past the end.
      if (received === cur.declared_size) return finish(c, project, ticket, cur, part);
      if (range.start !== received) {
        throw new HttpError(409, 'range_mismatch', `Expected the chunk starting at byte ${received}`, { receivedBytes: received });
      }

      const dir = tmpDir(deps.config.dataDir);
      await mkdir(partialDir(deps.config.dataDir), { recursive: true });
      const tmp = join(dir, `${ulid()}.chunk`);
      const chunk = await streamToFile(c.req.raw.body, tmp, chunkBytes);
      try {
        if (chunk.size !== chunkBytes) throw invalid(`Received ${chunk.size} of ${chunkBytes} bytes`);
        if (chunkSha !== undefined && chunk.sha256 !== chunkSha) throw new HttpError(422, 'hash_mismatch', 'Chunk does not match X-Chunk-SHA256', { chunk: true });
        // Catch a wrong file at its first chunk instead of after the whole upload.
        if (range.start === 0 && chunk.size >= 16 && !magicMatches(cur.content_type, chunk.head)) {
          throw new HttpError(422, 'magic_mismatch', `Body is not a valid ${cur.content_type}`);
        }
        await appendFileTo(tmp, part);
      } finally {
        await rm(tmp, { force: true });
      }
      received += chunk.size;
      deps.tickets.setReceivedBytes(cur.id, received);
      if (received < cur.declared_size) return c.json({ name: cur.name, state: 'partial', receivedBytes: received } satisfies AttachmentPartial, 202);
      return finish(c, project, ticket, cur, part);
    });
  }

  /** Verifies an assembled upload; a bad one is thrown away so the client starts again from 0. */
  async function finish(c: Context<AppEnv>, project: Project, ticket: TicketRow, att: AttachmentRow, part: string) {
    const file = await hashFile(part);
    const discard = async () => {
      await rm(part, { force: true });
      deps.tickets.setReceivedBytes(att.id, 0);
    };
    if (file.size !== att.declared_size || file.sha256 !== att.declared_sha256) {
      await discard();
      throw new HttpError(422, 'hash_mismatch', 'The assembled file does not match X-Content-SHA256; upload it again from byte 0');
    }
    if (!magicMatches(att.content_type, file.head)) {
      await discard();
      throw new HttpError(422, 'magic_mismatch', `Body is not a valid ${att.content_type}`);
    }
    return store(c, project, ticket, att, part, file);
  }

  async function store(c: Context<AppEnv>, project: Project, ticket: TicketRow, att: AttachmentRow, path: string, file: StreamedFile) {
    const key = attachmentKey(project.id, ticket.id, att.id);
    await deps.blobs.putFile(key, path, att.content_type);
    deps.tickets.markStored(att.id, file.size, file.sha256, key);
    return c.json({ name: att.name, state: 'stored', sizeBytes: file.size } satisfies AttachmentStored, 201);
  }

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

/** Re-sending a stored file is fine; a different file under the same name is not. */
function alreadyStored(c: Context<AppEnv>, att: AttachmentRow, sha: string) {
  if (att.sha256 === sha) return c.json({ name: att.name, state: 'stored', sizeBytes: att.size_bytes ?? att.declared_size } satisfies AttachmentStored, 200);
  throw new HttpError(409, 'conflict', 'A different file was already stored under this name');
}

async function createdBody(deps: Deps, prefix: string, t: TicketRow): Promise<ReportCreated> {
  const attachments: ReportCreated['attachments'] = [];
  for (const a of deps.tickets.attachments(t.id)) {
    // The partial file is the truth for the offset (see storage/partials.ts).
    if (a.state === 'missing') attachments.push({ name: a.name, state: a.state, receivedBytes: await fileSize(partialPath(deps.config.dataDir, a.id)) });
    else attachments.push({ name: a.name, state: a.state });
  }
  return {
    reportId: t.id,
    ticket: ticketKey(prefix, t.number),
    number: t.number,
    state: t.upload_state,
    attachments,
    upload: { resumable: true, chunkBytes: deps.config.uploadChunkBytes },
  };
}
