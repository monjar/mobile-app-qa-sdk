/**
 * Escalation targets (GitHub, email, webhooks), the per-project routing rules
 * that pick them by report type, and the record of each escalation.
 * Integration secrets are sealed with SecretBox and never leave the server.
 */
import type {
  EscalationState,
  EscalationView,
  IntegrationKind,
  IntegrationView,
  RoutingRule,
  RoutingRuleView,
} from '@snitch/contract';
import type { Db } from '../db/open';
import type { SecretBox } from '../crypto/secretBox';
import type { Clock } from '../util/clock';
import { ulid } from '../util/ids';
import { parseJson, toJson } from '../util/json';

export interface IntegrationRow {
  id: string;
  project_id: string;
  kind: IntegrationKind;
  name: string;
  config_json: string;
  secret_enc: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface EscalationRow {
  id: string;
  ticket_id: string;
  integration_id: string;
  state: EscalationState;
  external_id: string | null;
  external_url: string | null;
  last_error: string | null;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
}

export function toIntegrationView(r: IntegrationRow): IntegrationView {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    name: r.name,
    config: parseJson(r.config_json, {}) as IntegrationView['config'],
    hasSecret: r.secret_enc !== null,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class IntegrationsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: Clock,
    private readonly box: SecretBox,
  ) {}

  create(projectId: string, kind: IntegrationKind, name: string, config: unknown, secret: string | null): IntegrationView {
    const t = this.now();
    const id = ulid(t);
    this.db
      .prepare('INSERT INTO integrations (id, project_id, kind, name, config_json, secret_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, projectId, kind, name, toJson(config), secret ? this.box.seal(secret) : null, t, t);
    return toIntegrationView(this.get(id)!);
  }

  get(id: string): IntegrationRow | null {
    return (this.db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationRow | undefined) ?? null;
  }

  list(projectId: string): IntegrationView[] {
    return (this.db.prepare('SELECT * FROM integrations WHERE project_id = ? ORDER BY created_at').all(projectId) as IntegrationRow[]).map(toIntegrationView);
  }

  update(id: string, patch: { name?: string; config?: unknown; secret?: string; enabled?: boolean }): IntegrationView | null {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.config !== undefined) (sets.push('config_json = ?'), args.push(toJson(patch.config)));
    if (patch.secret !== undefined) (sets.push('secret_enc = ?'), args.push(this.box.seal(patch.secret)));
    if (patch.enabled !== undefined) (sets.push('enabled = ?'), args.push(patch.enabled ? 1 : 0));
    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(this.now(), id);
      this.db.prepare(`UPDATE integrations SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    }
    const r = this.get(id);
    return r ? toIntegrationView(r) : null;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM integrations WHERE id = ?').run(id);
  }

  secret(row: IntegrationRow): string | null {
    return row.secret_enc ? this.box.open(row.secret_enc) : null;
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  rules(projectId: string): RoutingRuleView[] {
    const rows = this.db.prepare('SELECT * FROM routing_rules WHERE project_id = ? ORDER BY position').all(projectId) as {
      id: string;
      report_type: string;
      integration_id: string;
      mode: 'auto' | 'suggest';
      position: number;
      enabled: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      reportType: r.report_type,
      integrationId: r.integration_id,
      mode: r.mode,
      position: r.position,
      enabled: r.enabled === 1,
    }));
  }

  replaceRules(projectId: string, rules: RoutingRule[]): RoutingRuleView[] {
    const t = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM routing_rules WHERE project_id = ?').run(projectId);
      const ins = this.db.prepare(
        'INSERT INTO routing_rules (id, project_id, report_type, integration_id, mode, position, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      rules.forEach((r, i) => ins.run(ulid(t), projectId, r.reportType, r.integrationId, r.mode, i, r.enabled ? 1 : 0));
    })();
    return this.rules(projectId);
  }

  /** Enabled rules (with enabled integrations) that match a report type, in order, deduplicated by integration. */
  matchingRules(projectId: string, reportType: string): RoutingRuleView[] {
    const seen = new Set<string>();
    return this.rules(projectId).filter((r) => {
      if (!r.enabled || (r.reportType !== '*' && r.reportType !== reportType) || seen.has(r.integrationId)) return false;
      const integ = this.get(r.integrationId);
      if (!integ || integ.enabled !== 1) return false;
      seen.add(r.integrationId);
      return true;
    });
  }

  // ── Escalations ──────────────────────────────────────────────────────────

  escalation(id: string): EscalationRow | null {
    return (this.db.prepare('SELECT * FROM escalations WHERE id = ?').get(id) as EscalationRow | undefined) ?? null;
  }

  escalationFor(ticketId: string, integrationId: string): EscalationRow | null {
    return (
      (this.db.prepare('SELECT * FROM escalations WHERE ticket_id = ? AND integration_id = ?').get(ticketId, integrationId) as EscalationRow | undefined) ??
      null
    );
  }

  /** Creates (or re-queues a failed) escalation. Returns null when one is already queued or sent. */
  queueEscalation(ticketId: string, integrationId: string, userId: string | null): EscalationRow | null {
    const t = this.now();
    const existing = this.escalationFor(ticketId, integrationId);
    if (existing) {
      if (existing.state !== 'failed') return null;
      this.db.prepare("UPDATE escalations SET state = 'queued', last_error = NULL, updated_at = ? WHERE id = ?").run(t, existing.id);
      return this.escalation(existing.id);
    }
    const id = ulid(t);
    this.db
      .prepare(
        "INSERT INTO escalations (id, ticket_id, integration_id, state, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
      )
      .run(id, ticketId, integrationId, userId, t, t);
    return this.escalation(id);
  }

  markSent(id: string, externalId: string | null, externalUrl: string | null): void {
    this.db
      .prepare("UPDATE escalations SET state = 'sent', external_id = ?, external_url = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(externalId, externalUrl, this.now(), id);
  }

  recordError(id: string, error: string, failed: boolean): void {
    this.db
      .prepare(`UPDATE escalations SET last_error = ?, updated_at = ?${failed ? ", state = 'failed'" : ''} WHERE id = ?`)
      .run(error.slice(0, 1000), this.now(), id);
  }

  escalationViews(ticketId: string): EscalationView[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, i.name AS i_name, i.kind AS i_kind FROM escalations e JOIN integrations i ON i.id = e.integration_id
         WHERE e.ticket_id = ? ORDER BY e.created_at`,
      )
      .all(ticketId) as (EscalationRow & { i_name: string; i_kind: IntegrationKind })[];
    return rows.map((r) => ({
      id: r.id,
      integrationId: r.integration_id,
      integrationName: r.i_name,
      kind: r.i_kind,
      state: r.state,
      externalUrl: r.external_url,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
