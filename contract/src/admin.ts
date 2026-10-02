/**
 * The dashboard ↔ server admin API (/api/admin/*).
 *
 * Request bodies are zod schemas (the server validates them); responses are
 * plain interfaces (the dashboard reads them). Auth is a session cookie plus an
 * X-CSRF-Token header on every non-GET request.
 */
import { z } from 'zod';
import {
  EscalationState,
  IntegrationKind,
  Platform,
  ReleaseType,
  TicketStatus,
  UploadState,
  UserRole,
} from './enums';
import type { AppInfo, CaptureStats, DeviceInfo, ReportTypeOption, SdkConfig, SdkConfigOverride, SdkInfo } from './ingest';
import { ReportTypeOption as ReportTypeOptionSchema, REPORT_TYPE_ID, SdkConfigOverride as SdkConfigOverrideSchema } from './ingest';

export const ADMIN_PREFIX = '/api/admin';
export const CSRF_HEADER = 'x-csrf-token';

// ── Auth & users ────────────────────────────────────────────────────────────

export interface UserView {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: number;
  lastLoginAt: number | null;
  disabled: boolean;
}

export interface Me {
  user: UserView;
  csrfToken: string;
}

export const LoginRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const PASSWORD_MIN_LENGTH = 10;

export const UserCreate = z.object({
  email: z.email().max(254),
  name: z.string().max(120).optional(),
  role: UserRole,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
});
export type UserCreate = z.infer<typeof UserCreate>;

export const UserUpdate = z
  .object({
    name: z.string().max(120).nullable(),
    role: UserRole,
    disabled: z.boolean(),
    password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
  })
  .partial();
export type UserUpdate = z.infer<typeof UserUpdate>;

// ── Projects & keys ─────────────────────────────────────────────────────────

export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const TICKET_PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;

export interface ProjectView {
  id: string;
  slug: string;
  name: string;
  ticketPrefix: string;
  reportTypes: ReportTypeOption[];
  allowedAppIds: string[] | null;
  allowedReleaseTypes: ReleaseType[];
  retentionDays: number | null;
  createdAt: number;
  openTickets: number;
}

export const ProjectCreate = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().regex(PROJECT_SLUG),
  ticketPrefix: z.string().regex(TICKET_PREFIX),
});
export type ProjectCreate = z.infer<typeof ProjectCreate>;

export const ProjectUpdate = z
  .object({
    name: z.string().min(1).max(80),
    reportTypes: z.array(ReportTypeOptionSchema).min(1).max(8),
    allowedAppIds: z.array(z.string().min(1).max(255)).max(20).nullable(),
    allowedReleaseTypes: z.array(ReleaseType),
    retentionDays: z.number().int().min(1).max(3650).nullable(),
  })
  .partial();
export type ProjectUpdate = z.infer<typeof ProjectUpdate>;

export interface IngestKeyView {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface IngestKeyCreated {
  key: IngestKeyView;
  /** Shown once; only its hash is stored. */
  plaintext: string;
}

export const IngestKeyCreate = z.object({ label: z.string().max(80).optional() });

// ── Remote SDK config ───────────────────────────────────────────────────────

export const Wildcard = z.literal('*');
export const SdkConfigEntry = z.object({
  platform: z.union([Platform, Wildcard]),
  releaseType: z.union([ReleaseType, Wildcard]),
  config: SdkConfigOverrideSchema,
});
export type SdkConfigEntry = z.infer<typeof SdkConfigEntry>;

export const SdkConfigEntries = z.object({ entries: z.array(SdkConfigEntry).max(64) });

export interface SdkConfigView {
  entries: SdkConfigEntry[];
  /** Effective config for every platform × release type, after merging. */
  effective: Record<string, SdkConfig>;
}
export type { SdkConfigOverride };

// ── Tickets ─────────────────────────────────────────────────────────────────

export interface PersonRef {
  id: string;
  name: string | null;
  email: string;
}

export interface EscalationBadge {
  integrationId: string;
  kind: IntegrationKind;
  name: string;
  state: EscalationState;
  url: string | null;
}

export interface TicketSummary {
  id: string;
  key: string;
  projectId: string;
  number: number;
  type: string;
  status: TicketStatus;
  uploadState: UploadState;
  title: string;
  platform: Platform;
  releaseType: ReleaseType;
  appVersion: string;
  appBuild: string;
  deviceModel: string;
  osVersion: string;
  hasScreenshot: boolean;
  videoSeconds: number | null;
  reporterEmail: string | null;
  assignee: PersonRef | null;
  escalations: EscalationBadge[];
  createdAt: number;
  updatedAt: number;
}

export interface TicketList {
  items: TicketSummary[];
  nextCursor: string | null;
  counts: Record<TicketStatus, number>;
}

export const TicketListQuery = z.object({
  projectId: z.string().optional(),
  status: z.union([TicketStatus, z.literal('open'), z.literal('all')]).optional(),
  type: z.string().regex(REPORT_TYPE_ID).optional(),
  platform: Platform.optional(),
  releaseType: ReleaseType.optional(),
  assignee: z.string().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type TicketListQuery = z.infer<typeof TicketListQuery>;

export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  stored: boolean;
  /** Same-origin URL, cookie-authenticated, Range-capable. */
  url: string;
  shareLinks: ShareLinkView[];
}

export interface ShareLinkView {
  id: string;
  url: string | null;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
}

export const TICKET_EVENT_KINDS = [
  'created',
  'completed',
  'incomplete',
  'status_changed',
  'assigned',
  'type_changed',
  'title_changed',
  'comment',
  'escalation_suggested',
  'escalation_queued',
  'escalated',
  'escalation_failed',
  'share_link_created',
  'share_link_revoked',
] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];

export interface TicketEventView {
  id: number;
  kind: TicketEventKind;
  actor: { type: 'sdk' | 'user' | 'system' | 'integration'; userId: string | null; name: string | null };
  data: Record<string, unknown>;
  createdAt: number;
}

export interface EscalationView {
  id: string;
  integrationId: string;
  integrationName: string;
  kind: IntegrationKind;
  state: EscalationState;
  externalUrl: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TicketDetail {
  ticket: TicketSummary & {
    description: string;
    reporter: { email: string | null; name: string | null; id: string | null };
    trigger: string | null;
    reportedAt: number;
    duplicateOfId: string | null;
    app: AppInfo;
    device: DeviceInfo;
    sdk: SdkInfo;
    custom: Record<string, string>;
    stats: CaptureStats;
  };
  project: { id: string; slug: string; name: string; reportTypes: ReportTypeOption[] };
  attachments: AttachmentView[];
  events: TicketEventView[];
  escalations: EscalationView[];
  /** Integrations routing rules suggest for this ticket's type, not yet escalated to. */
  suggestedIntegrationIds: string[];
}

export const TicketPatch = z
  .object({
    status: TicketStatus,
    assigneeUserId: z.string().nullable(),
    type: z.string().regex(REPORT_TYPE_ID),
    title: z.string().min(1).max(200),
    duplicateOfId: z.string().nullable(),
  })
  .partial();
export type TicketPatch = z.infer<typeof TicketPatch>;

export const CommentCreate = z.object({ body: z.string().min(1).max(10_000) });
export type CommentCreate = z.infer<typeof CommentCreate>;

export const EscalationCreate = z.object({ integrationId: z.string().min(1) });
export type EscalationCreate = z.infer<typeof EscalationCreate>;

export const ShareLinkCreate = z.object({ expiresInDays: z.number().int().min(1).max(365).nullable().optional() });
export type ShareLinkCreate = z.infer<typeof ShareLinkCreate>;

// ── Integrations & routing ──────────────────────────────────────────────────

export const GithubConfig = z.object({
  owner: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  labels: z.array(z.string().min(1).max(50)).max(10).default([]),
  assignees: z.array(z.string().min(1).max(39)).max(10).default([]),
  /** Put public, expiring share links to the screenshot/video in the issue. Off by default: GitHub caches images. */
  includeShareLinks: z.boolean().default(false),
  shareTtlDays: z.number().int().min(1).max(365).default(30),
  /** Override for GitHub Enterprise; defaults to https://api.github.com. */
  apiBaseUrl: z.url().optional(),
});
export type GithubConfig = z.infer<typeof GithubConfig>;

export const EmailConfig = z.object({
  to: z.array(z.email()).min(1).max(20),
  subjectPrefix: z.string().max(40).default('[Snitch]'),
});
export type EmailConfig = z.infer<typeof EmailConfig>;

export const WEBHOOK_FORMATS = ['generic', 'slack', 'discord'] as const;
export const WebhookConfig = z.object({
  url: z.url(),
  format: z.enum(WEBHOOK_FORMATS).default('generic'),
  includeShareLinks: z.boolean().default(false),
  shareTtlDays: z.number().int().min(1).max(365).default(30),
});
export type WebhookConfig = z.infer<typeof WebhookConfig>;

export const IntegrationCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github'), name: z.string().min(1).max(80), config: GithubConfig, secret: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('email'), name: z.string().min(1).max(80), config: EmailConfig }),
  z.object({
    kind: z.literal('webhook'),
    name: z.string().min(1).max(80),
    config: WebhookConfig,
    /** HMAC signing secret for generic webhooks; ignored for slack/discord. */
    secret: z.string().min(1).max(500).optional(),
  }),
]);
export type IntegrationCreate = z.infer<typeof IntegrationCreate>;

export const IntegrationUpdate = z.object({
  name: z.string().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secret: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationUpdate = z.infer<typeof IntegrationUpdate>;

export interface IntegrationView {
  id: string;
  projectId: string;
  kind: IntegrationKind;
  name: string;
  config: GithubConfig | EmailConfig | WebhookConfig;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const ROUTING_MODES = ['auto', 'suggest'] as const;
export const RoutingRule = z.object({
  reportType: z.union([z.string().regex(REPORT_TYPE_ID), z.literal('*')]),
  integrationId: z.string().min(1),
  mode: z.enum(ROUTING_MODES),
  enabled: z.boolean().default(true),
});
export type RoutingRule = z.infer<typeof RoutingRule>;
export const RoutingRules = z.object({ rules: z.array(RoutingRule).max(100) });

export interface RoutingRuleView extends RoutingRule {
  id: string;
  position: number;
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export const JOB_STATES = ['queued', 'running', 'done', 'dead'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobView {
  id: number;
  kind: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  lastError: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntryView {
  id: number;
  user: PersonRef | null;
  action: string;
  target: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: number;
}

export interface ServerInfo {
  version: string;
  publicUrl: string;
  storage: 'fs' | 's3';
  mail: 'smtp' | 'console';
}
