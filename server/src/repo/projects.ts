/**
 * Projects (one per app), their ingest keys, and their remote SDK config.
 */
import {
  DEFAULT_ENABLED_RELEASE_TYPES,
  DEFAULT_SDK_CONFIG,
  mergeSdkConfig,
  PLATFORMS,
  RELEASE_TYPES,
  type IngestKeyView,
  type Platform,
  type ProjectCreate,
  type ProjectUpdate,
  type ProjectView,
  type ReleaseType,
  type ReportTypeOption,
  type SdkConfig,
  type SdkConfigEntry,
  type SdkConfigOverride,
} from '@snitch/contract';
import type { Db } from '../db/open';
import { randomBase32, ulid } from '../util/ids';
import { parseJson, toJson } from '../util/json';
import { sha256Hex } from '../crypto/tokens';
import type { Clock } from '../util/clock';

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  ticket_prefix: string;
  next_ticket_number: number;
  report_types_json: string;
  allowed_app_ids_json: string | null;
  allowed_release_types_json: string;
  retention_days: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  ticketPrefix: string;
  reportTypes: ReportTypeOption[];
  allowedAppIds: string[] | null;
  allowedReleaseTypes: ReleaseType[];
  retentionDays: number | null;
  createdAt: number;
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    ticketPrefix: r.ticket_prefix,
    reportTypes: parseJson(r.report_types_json, DEFAULT_SDK_CONFIG.reportTypes),
    allowedAppIds: parseJson<string[] | null>(r.allowed_app_ids_json, null),
    allowedReleaseTypes: parseJson<ReleaseType[]>(r.allowed_release_types_json, [...DEFAULT_ENABLED_RELEASE_TYPES]),
    retentionDays: r.retention_days,
    createdAt: r.created_at,
  };
}

export const INGEST_KEY_PREFIX = 'snitch_pk_';

export function generateIngestKey(): string {
  return INGEST_KEY_PREFIX + randomBase32(26);
}

export class ProjectsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
  ) {}

  create(input: ProjectCreate): Project {
    const t = this.now();
    const id = ulid(t);
    this.db
      .prepare(
        `INSERT INTO projects (id, slug, name, ticket_prefix, report_types_json, allowed_release_types_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.slug, input.name, input.ticketPrefix, toJson(DEFAULT_SDK_CONFIG.reportTypes), toJson(DEFAULT_ENABLED_RELEASE_TYPES), t, t);
    return this.get(id)!;
  }

  get(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  getBySlug(slug: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  list(): ProjectView[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM tickets t WHERE t.project_id = p.id AND t.status IN ('new','triaged','in_progress')) AS open_tickets
         FROM projects p WHERE p.archived_at IS NULL ORDER BY p.name COLLATE NOCASE`,
      )
      .all() as (ProjectRow & { open_tickets: number })[];
    return rows.map((r) => ({ ...toProject(r), openTickets: r.open_tickets }));
  }

  view(id: string): ProjectView | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  update(id: string, patch: ProjectUpdate): Project | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.reportTypes !== undefined) (sets.push('report_types_json = ?'), args.push(toJson(patch.reportTypes)));
    if (patch.allowedAppIds !== undefined) (sets.push('allowed_app_ids_json = ?'), args.push(patch.allowedAppIds === null ? null : toJson(patch.allowedAppIds)));
    if (patch.allowedReleaseTypes !== undefined) (sets.push('allowed_release_types_json = ?'), args.push(toJson(patch.allowedReleaseTypes)));
    if (patch.retentionDays !== undefined) (sets.push('retention_days = ?'), args.push(patch.retentionDays));
    if (sets.length > 0) {
      sets.push('updated_at = ?');
      args.push(this.now(), id);
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    return this.get(id);
  }

  /** Allocates the next per-project ticket number. Call inside the ticket-insert transaction. */
  allocateNumber(projectId: string): number {
    const r = this.db
      .prepare('UPDATE projects SET next_ticket_number = next_ticket_number + 1 WHERE id = ? RETURNING next_ticket_number - 1 AS n')
      .get(projectId) as { n: number } | undefined;
    if (!r) throw new Error(`project ${projectId} not found`);
    return r.n;
  }

  // ── Ingest keys ──────────────────────────────────────────────────────────

  createKey(projectId: string, label: string | null, plaintext: string = generateIngestKey()): { key: IngestKeyView; plaintext: string } {
    const t = this.now();
    const id = ulid(t);
    this.db
      .prepare('INSERT INTO ingest_keys (id, project_id, key_hash, key_prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, sha256Hex(plaintext), plaintext.slice(0, INGEST_KEY_PREFIX.length + 4), label, t);
    return { key: this.keyView(id)!, plaintext };
  }

  listKeys(projectId: string): IngestKeyView[] {
    const rows = this.db.prepare('SELECT * FROM ingest_keys WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as KeyRow[];
    return rows.map(toKeyView);
  }

  keyView(id: string): IngestKeyView | null {
    const r = this.db.prepare('SELECT * FROM ingest_keys WHERE id = ?').get(id) as KeyRow | undefined;
    return r ? toKeyView(r) : null;
  }

  keyProject(keyId: string): string | null {
    const r = this.db.prepare('SELECT project_id FROM ingest_keys WHERE id = ?').get(keyId) as { project_id: string } | undefined;
    return r?.project_id ?? null;
  }

  revokeKey(id: string): void {
    this.db.prepare('UPDATE ingest_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(this.now(), id);
  }

  /** Resolves a plaintext ingest key to its project, ignoring revoked keys. */
  authenticate(plaintext: string): { keyId: string; project: Project; lastUsedAt: number | null } | null {
    const r = this.db
      .prepare(
        `SELECT k.id AS key_id, k.last_used_at, p.* FROM ingest_keys k JOIN projects p ON p.id = k.project_id
         WHERE k.key_hash = ? AND k.revoked_at IS NULL AND p.archived_at IS NULL`,
      )
      .get(sha256Hex(plaintext)) as (ProjectRow & { key_id: string; last_used_at: number | null }) | undefined;
    return r ? { keyId: r.key_id, project: toProject(r), lastUsedAt: r.last_used_at } : null;
  }

  touchKey(keyId: string): void {
    this.db.prepare('UPDATE ingest_keys SET last_used_at = ? WHERE id = ?').run(this.now(), keyId);
  }

  // ── Remote SDK config ────────────────────────────────────────────────────

  sdkConfigEntries(projectId: string): SdkConfigEntry[] {
    const rows = this.db
      .prepare('SELECT platform, release_type, config_json FROM sdk_configs WHERE project_id = ? ORDER BY platform, release_type')
      .all(projectId) as { platform: string; release_type: string; config_json: string }[];
    return rows.map((r) => ({
      platform: r.platform as Platform | '*',
      releaseType: r.release_type as ReleaseType | '*',
      config: parseJson<SdkConfigOverride>(r.config_json, {}),
    }));
  }

  replaceSdkConfig(projectId: string, entries: SdkConfigEntry[]): void {
    const t = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sdk_configs WHERE project_id = ?').run(projectId);
      const ins = this.db.prepare('INSERT OR REPLACE INTO sdk_configs (project_id, platform, release_type, config_json, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (const e of entries) ins.run(projectId, e.platform, e.releaseType, toJson(e.config), t);
    })();
  }

  /**
   * Effective config for one device: defaults, then the project's report types,
   * then entries from least to most specific (*\/* → platform/* → *\/release → platform/release).
   */
  effectiveSdkConfig(project: Project, platform: Platform, releaseType: ReleaseType, entries = this.sdkConfigEntries(project.id)): SdkConfig {
    const rank = (e: SdkConfigEntry) => (e.platform === '*' ? 0 : 1) + (e.releaseType === '*' ? 0 : 2);
    const matching = entries
      .filter((e) => (e.platform === '*' || e.platform === platform) && (e.releaseType === '*' || e.releaseType === releaseType))
      .sort((a, b) => rank(a) - rank(b))
      .map((e) => e.config);
    const base = mergeSdkConfig(DEFAULT_SDK_CONFIG, { reportTypes: project.reportTypes });
    const merged = mergeSdkConfig(base, ...matching);
    // The project allowlist always wins: a disallowed release type gets a disabled SDK.
    if (!project.allowedReleaseTypes.includes(releaseType)) return { ...merged, enabled: false };
    return merged;
  }

  effectiveMatrix(project: Project): Record<string, SdkConfig> {
    const entries = this.sdkConfigEntries(project.id);
    const out: Record<string, SdkConfig> = {};
    for (const p of PLATFORMS) for (const r of RELEASE_TYPES) out[`${p}/${r}`] = this.effectiveSdkConfig(project, p, r, entries);
    return out;
  }
}

interface KeyRow {
  id: string;
  project_id: string;
  key_prefix: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

function toKeyView(r: KeyRow): IngestKeyView {
  return { id: r.id, prefix: r.key_prefix, label: r.label, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at };
}
