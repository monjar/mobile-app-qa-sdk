/**
 * Tickets (one per report), their attachments, their event log, and public
 * share links to attachments.
 *
 * The event log is the ticket's history ("logged" in the product sense): every
 * state change, comment and escalation is an append-only row.
 */
import type {
  AttachmentView,
  EscalationBadge,
  IntegrationKind,
  ReportCreate,
  ShareLinkView,
  TicketEventKind,
  TicketEventView,
  TicketListQuery,
  TicketStatus,
  TicketSummary,
  UploadState,
} from '@snitch/contract';
import { TICKET_STATUSES } from '@snitch/contract';
import type { Db } from '../db/open';
import type { Clock } from '../util/clock';
import { ulid } from '../util/ids';
import { parseJson, toJson } from '../util/json';
import { randomToken, sha256Hex } from '../crypto/tokens';
import type { Project, ProjectsRepo } from './projects';

export interface TicketRow {
  id: string;
  project_id: string;
  number: number;
  client_report_id: string;
  type: string;
  status: TicketStatus;
  upload_state: UploadState;
  title: string;
  description: string;
  reporter_email: string | null;
  reporter_name: string | null;
  reporter_id: string | null;
  platform: 'ios' | 'android';
  release_type: string;
  app_id: string;
  app_version: string;
  app_build: string;
  os_version: string;
  device_model: string;
  sdk_version: string;
  trigger: string | null;
  metadata_json: string;
  assignee_user_id: string | null;
  duplicate_of_id: string | null;
  reported_at: number;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  ticket_id: string;
  name: string;
  content_type: string;
  declared_size: number;
  declared_sha256: string;
  size_bytes: number | null;
  sha256: string | null;
  storage_key: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  state: 'missing' | 'stored';
  created_at: number;
  stored_at: number | null;
}

export interface TicketMetadata {
  app: ReportCreate['app'];
  device: ReportCreate['device'];
  sdk: ReportCreate['sdk'];
  custom: Record<string, string>;
  stats: NonNullable<ReportCreate['stats']>;
}

export type Actor = { type: 'sdk' | 'system' | 'integration'; userId?: null } | { type: 'user'; userId: string };

/** First non-empty line of the description, trimmed to 120 characters. */
export function deriveTitle(description: string, typeLabel: string): string {
  const line = description
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return `${typeLabel} report`;
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

export function ticketKey(prefix: string, n: number): string {
  return `${prefix}-${n}`;
}

const OPEN_STATUSES: TicketStatus[] = ['new', 'triaged', 'in_progress'];

export class TicketsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
    private readonly projects: ProjectsRepo,
  ) {}

  // ── Intake ───────────────────────────────────────────────────────────────

  findByClientId(projectId: string, clientReportId: string): TicketRow | null {
    return (
      (this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND client_report_id = ?').get(projectId, clientReportId) as TicketRow | undefined) ??
      null
    );
  }

  /** Inserts the ticket, its declared attachments and the `created` event atomically. */
  createFromReport(project: Project, report: ReportCreate): TicketRow {
    const t = this.now();
    const id = ulid(t);
    const typeLabel = project.reportTypes.find((r) => r.id === report.type)?.label ?? report.type;
    const metadata: TicketMetadata = {
      app: report.app,
      device: report.device,
      sdk: report.sdk,
      custom: report.custom ?? {},
      stats: report.stats ?? {},
    };
    const reportedAt = Date.parse(report.reportedAt);
    this.db.transaction(() => {
      const number = this.projects.allocateNumber(project.id);
      this.db
        .prepare(
          `INSERT INTO tickets (id, project_id, number, client_report_id, type, title, description, reporter_email, reporter_name, reporter_id,
             platform, release_type, app_id, app_version, app_build, os_version, device_model, sdk_version, trigger, metadata_json,
             reported_at, created_at, updated_at, upload_state, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          project.id,
          number,
          report.clientReportId,
          report.type,
          deriveTitle(report.description, typeLabel),
          report.description,
          report.reporter?.email ?? null,
          report.reporter?.name ?? null,
          report.reporter?.id ?? null,
          report.device.platform,
          report.app.releaseType,
          report.app.id,
          report.app.version,
          report.app.build,
          report.device.osVersion,
          report.device.model,
          report.sdk.version,
          report.trigger,
          toJson(metadata),
          Number.isFinite(reportedAt) ? reportedAt : t,
          t,
          t,
          report.attachments.length === 0 ? 'complete' : 'pending',
          report.attachments.length === 0 ? t : null,
        );
      const ins = this.db.prepare(
        `INSERT INTO attachments (id, ticket_id, name, content_type, declared_size, declared_sha256, width, height, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const a of report.attachments) {
        ins.run(ulid(t), id, a.name, a.contentType, a.sizeBytes, a.sha256, a.width ?? null, a.height ?? null, a.durationMs ?? null, t);
      }
      this.addEvent(id, { type: 'sdk' }, 'created', { trigger: report.trigger, attachments: report.attachments.map((a) => a.name) });
      if (report.attachments.length === 0) this.addEvent(id, { type: 'sdk' }, 'completed', {});
    })();
    return this.get(id)!;
  }

  /** Marks the upload complete (idempotent). Returns true if this call changed it. */
  complete(ticketId: string): boolean {
    const t = this.now();
    const changed = this.db
      .prepare("UPDATE tickets SET upload_state = 'complete', completed_at = ?, updated_at = ? WHERE id = ? AND upload_state = 'pending'")
      .run(t, t, ticketId).changes;
    if (changed) this.addEvent(ticketId, { type: 'sdk' }, 'completed', {});
    return changed > 0;
  }

  /** Pending uploads older than `cutoff` become `incomplete`; returns their ids. */
  sweepStale(cutoff: number): string[] {
    const ids = (this.db.prepare("SELECT id FROM tickets WHERE upload_state = 'pending' AND created_at < ?").all(cutoff) as { id: string }[]).map(
      (r) => r.id,
    );
    const t = this.now();
    for (const id of ids) {
      this.db.prepare("UPDATE tickets SET upload_state = 'incomplete', completed_at = ?, updated_at = ? WHERE id = ?").run(t, t, id);
      const missing = this.attachments(id)
        .filter((a) => a.state === 'missing')
        .map((a) => a.name);
      this.addEvent(id, { type: 'system' }, 'incomplete', { missing });
    }
    return ids;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  get(id: string): TicketRow | null {
    return (this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as TicketRow | undefined) ?? null;
  }

  metadata(row: TicketRow): TicketMetadata {
    return parseJson<TicketMetadata>(row.metadata_json, {
      app: { id: row.app_id, version: row.app_version, build: row.app_build, releaseType: row.release_type as never },
      device: { platform: row.platform, osVersion: row.os_version, model: row.device_model },
      sdk: { name: 'unknown', version: row.sdk_version },
      custom: {},
      stats: {},
    });
  }

  list(q: TicketListQuery, projectIds: string[] | null): { items: TicketSummary[]; nextCursor: string | null; counts: Record<TicketStatus, number> } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.projectId) (where.push('t.project_id = ?'), args.push(q.projectId));
    if (projectIds) where.push(`t.project_id IN (${projectIds.map(() => '?').join(',') || "''"})`), args.push(...projectIds);
    if (q.type) (where.push('t.type = ?'), args.push(q.type));
    if (q.platform) (where.push('t.platform = ?'), args.push(q.platform));
    if (q.releaseType) (where.push('t.release_type = ?'), args.push(q.releaseType));
    if (q.assignee === 'none') where.push('t.assignee_user_id IS NULL');
    else if (q.assignee) (where.push('t.assignee_user_id = ?'), args.push(q.assignee));
    if (q.q) {
      const key = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/i.exec(q.q.trim());
      if (key) {
        where.push('(t.number = ? AND t.project_id IN (SELECT id FROM projects WHERE ticket_prefix = ?))');
        args.push(Number(key[2]), key[1]!.toUpperCase());
      } else {
        const like = `%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
        where.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\' OR t.reporter_email LIKE ? ESCAPE '\\' OR t.device_model LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
    }
    // Counts ignore the status filter so the tabs can show every bucket.
    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = this.db.prepare(`SELECT t.status, COUNT(*) AS n FROM tickets t ${baseWhere} GROUP BY t.status`).all(...args) as {
      status: TicketStatus;
      n: number;
    }[];
    const counts = Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])) as Record<TicketStatus, number>;
    for (const r of countRows) counts[r.status] = r.n;

    const status = q.status ?? 'open';
    if (status === 'open') where.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), args.push(...OPEN_STATUSES);
    else if (status !== 'all') (where.push('t.status = ?'), args.push(status));
    if (q.cursor) {
      const [c, id] = Buffer.from(q.cursor, 'base64url').toString('utf8').split(':');
      if (c && id) (where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))'), args.push(Number(c), Number(c), id));
    }
    const limit = q.limit ?? 50;
    const rows = this.db
      .prepare(`SELECT t.* FROM tickets t ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
      .all(...args, limit + 1) as TicketRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: this.summaries(page),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.created_at}:${last.id}`).toString('base64url') : null,
      counts,
    };
  }

  /** Builds dashboard summaries for rows in one batch of queries. */
  summaries(rows: TicketRow[]): TicketSummary[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const atts = this.db.prepare(`SELECT * FROM attachments WHERE ticket_id IN (${marks})`).all(...ids) as AttachmentRow[];
    const escs = this.db
      .prepare(
        `SELECT e.ticket_id, e.integration_id, e.state, e.external_url, i.kind, i.name FROM escalations e
         JOIN integrations i ON i.id = e.integration_id WHERE e.ticket_id IN (${marks}) ORDER BY e.created_at`,
      )
      .all(...ids) as { ticket_id: string; integration_id: string; state: EscalationBadge['state']; external_url: string | null; kind: IntegrationKind; name: string }[];
    const prefixes = new Map(
      (this.db.prepare(`SELECT id, ticket_prefix FROM projects`).all() as { id: string; ticket_prefix: string }[]).map((p) => [p.id, p.ticket_prefix]),
    );
    const assigneeIds = [...new Set(rows.map((r) => r.assignee_user_id).filter((x): x is string => !!x))];
    const assignees = new Map(
      assigneeIds.length
        ? (this.db.prepare(`SELECT id, name, email FROM users WHERE id IN (${assigneeIds.map(() => '?').join(',')})`).all(...assigneeIds) as {
            id: string;
            name: string | null;
            email: string;
          }[]).map((u) => [u.id, u])
        : [],
    );
    return rows.map((r) => {
      const mine = atts.filter((a) => a.ticket_id === r.id);
      const video = mine.find((a) => a.content_type === 'video/mp4' && a.state === 'stored');
      return {
        id: r.id,
        key: ticketKey(prefixes.get(r.project_id) ?? '?', r.number),
        projectId: r.project_id,
        number: r.number,
        type: r.type,
        status: r.status,
        uploadState: r.upload_state,
        title: r.title,
        platform: r.platform,
        releaseType: r.release_type as TicketSummary['releaseType'],
        appVersion: r.app_version,
        appBuild: r.app_build,
        deviceModel: r.device_model,
        osVersion: r.os_version,
        hasScreenshot: mine.some((a) => a.content_type.startsWith('image/') && a.state === 'stored'),
        videoSeconds: video?.duration_ms ? Math.round(video.duration_ms / 100) / 10 : null,
        reporterEmail: r.reporter_email,
        assignee: r.assignee_user_id ? (assignees.get(r.assignee_user_id) ?? null) : null,
        escalations: escs
          .filter((e) => e.ticket_id === r.id)
          .map((e) => ({ integrationId: e.integration_id, kind: e.kind, name: e.name, state: e.state, url: e.external_url })),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  // ── Changes from the dashboard ───────────────────────────────────────────

  setStatus(id: string, status: TicketStatus, actor: Actor): boolean {
    const row = this.get(id);
    if (!row || row.status === status) return false;
    this.db.prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), id);
    this.addEvent(id, actor, 'status_changed', { from: row.status, to: status });
    return true;
  }

  setAssignee(id: string, userId: string | null, actor: Actor): boolean {
    const row = this.get(id);
    if (!row || row.assignee_user_id === userId) return false;
    this.db.prepare('UPDATE tickets SET assignee_user_id = ?, updated_at = ? WHERE id = ?').run(userId, this.now(), id);
    this.addEvent(id, actor, 'assigned', { from: row.assignee_user_id, to: userId });
    return true;
  }

  setType(id: string, type: string, actor: Actor): boolean {
    const row = this.get(id);
    if (!row || row.type === type) return false;
    this.db.prepare('UPDATE tickets SET type = ?, updated_at = ? WHERE id = ?').run(type, this.now(), id);
    this.addEvent(id, actor, 'type_changed', { from: row.type, to: type });
    return true;
  }

  setTitle(id: string, title: string, actor: Actor): boolean {
    const row = this.get(id);
    if (!row || row.title === title) return false;
    this.db.prepare('UPDATE tickets SET title = ?, updated_at = ? WHERE id = ?').run(title, this.now(), id);
    this.addEvent(id, actor, 'title_changed', { from: row.title, to: title });
    return true;
  }

  setDuplicateOf(id: string, duplicateOfId: string | null): void {
    this.db.prepare('UPDATE tickets SET duplicate_of_id = ?, updated_at = ? WHERE id = ?').run(duplicateOfId, this.now(), id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** Deletes the ticket rows; returns blob keys the caller must delete from storage. */
  delete(id: string): string[] {
    const keys = this.attachments(id)
      .map((a) => a.storage_key)
      .filter((k): k is string => !!k);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
    return keys;
  }

  /** Ticket ids older than the retention window of their project (or the global default). */
  expired(defaultDays: number): string[] {
    const t = this.now();
    const rows = this.db
      .prepare(
        `SELECT t.id FROM tickets t JOIN projects p ON p.id = t.project_id
         WHERE COALESCE(p.retention_days, ?) > 0 AND t.created_at < ? - COALESCE(p.retention_days, ?) * 86400000
         LIMIT 500`,
      )
      .all(defaultDays, t, defaultDays) as { id: string }[];
    return rows.map((r) => r.id);
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  attachments(ticketId: string): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at, name').all(ticketId) as AttachmentRow[];
  }

  attachment(ticketId: string, name: string): AttachmentRow | null {
    return (this.db.prepare('SELECT * FROM attachments WHERE ticket_id = ? AND name = ?').get(ticketId, name) as AttachmentRow | undefined) ?? null;
  }

  attachmentById(id: string): (AttachmentRow & { project_id: string }) | null {
    return (
      (this.db
        .prepare('SELECT a.*, t.project_id FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?')
        .get(id) as (AttachmentRow & { project_id: string }) | undefined) ?? null
    );
  }

  markStored(id: string, sizeBytes: number, sha256: string, storageKey: string): void {
    this.db
      .prepare("UPDATE attachments SET state = 'stored', size_bytes = ?, sha256 = ?, storage_key = ?, stored_at = ? WHERE id = ?")
      .run(sizeBytes, sha256, storageKey, this.now(), id);
  }

  attachmentViews(ticketId: string, publicUrl: string): AttachmentView[] {
    const links = this.db
      .prepare(
        `SELECT s.* FROM share_links s JOIN attachments a ON a.id = s.attachment_id WHERE a.ticket_id = ? ORDER BY s.created_at DESC`,
      )
      .all(ticketId) as ShareLinkRow[];
    return this.attachments(ticketId).map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.content_type,
      sizeBytes: a.size_bytes ?? a.declared_size,
      width: a.width,
      height: a.height,
      durationMs: a.duration_ms,
      stored: a.state === 'stored',
      url: `${publicUrl}/api/admin/attachments/${a.id}/content`,
      shareLinks: links.filter((l) => l.attachment_id === a.id).map(toShareLinkView),
    }));
  }

  // ── Events ───────────────────────────────────────────────────────────────

  addEvent(ticketId: string, actor: Actor, kind: TicketEventKind, data: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO ticket_events (ticket_id, actor_type, actor_user_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ticketId, actor.type, actor.type === 'user' ? actor.userId : null, kind, toJson(data), this.now());
  }

  events(ticketId: string): TicketEventView[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, u.name AS u_name, u.email AS u_email FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_user_id
         WHERE e.ticket_id = ? ORDER BY e.id`,
      )
      .all(ticketId) as {
      id: number;
      kind: TicketEventKind;
      actor_type: TicketEventView['actor']['type'];
      actor_user_id: string | null;
      u_name: string | null;
      u_email: string | null;
      data_json: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      actor: { type: r.actor_type, userId: r.actor_user_id, name: r.u_name ?? r.u_email },
      data: parseJson(r.data_json, {}),
      createdAt: r.created_at,
    }));
  }

  // ── Share links ──────────────────────────────────────────────────────────

  createShareLink(attachmentId: string, expiresInDays: number | null, userId: string | null): { id: string; token: string; expiresAt: number | null } {
    const t = this.now();
    const id = ulid(t);
    const token = randomToken(24);
    const expiresAt = expiresInDays ? t + expiresInDays * 86_400_000 : null;
    this.db
      .prepare('INSERT INTO share_links (id, attachment_id, token_hash, created_by_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, attachmentId, sha256Hex(token), userId, t, expiresAt);
    return { id, token, expiresAt };
  }

  shareLink(id: string): (ShareLinkRow & { ticket_id: string }) | null {
    return (
      (this.db
        .prepare('SELECT s.*, a.ticket_id FROM share_links s JOIN attachments a ON a.id = s.attachment_id WHERE s.id = ?')
        .get(id) as (ShareLinkRow & { ticket_id: string }) | undefined) ?? null
    );
  }

  revokeShareLink(id: string): void {
    this.db.prepare('UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(this.now(), id);
  }

  /** The attachment a live share-link token points to. */
  resolveShareToken(token: string): (AttachmentRow & { project_id: string }) | null {
    const r = this.db
      .prepare(
        `SELECT a.*, t.project_id FROM share_links s JOIN attachments a ON a.id = s.attachment_id JOIN tickets t ON t.id = a.ticket_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)`,
      )
      .get(sha256Hex(token), this.now()) as (AttachmentRow & { project_id: string }) | undefined;
    return r ?? null;
  }
}

interface ShareLinkRow {
  id: string;
  attachment_id: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

function toShareLinkView(r: ShareLinkRow): ShareLinkView {
  // The token is only known at creation time; afterwards the dashboard shows metadata only.
  return { id: r.id, url: null, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at };
}
