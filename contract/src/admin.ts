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
  /** Invited and hasn't set a password yet. */
  pending: boolean;
}

export interface Me {
  user: UserView;
  csrfToken: string;
}

/** GET /auth/providers — which sign-in methods the login page offers. */
export interface AuthProviders {
  password: true;
  /** Sign in with GitHub (OAuth app configured through SNITCH_GITHUB_CLIENT_ID / _SECRET). */
  github: boolean;
  /** "Forgot password?" can email a reset link (SMTP is configured). */
  passwordReset: boolean;
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
  /** Omit to invite: they get an email with a link to choose their own password. */
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512).optional(),
});
export type UserCreate = z.infer<typeof UserCreate>;

/** A one-time link to choose a password: an invite, or a reset an admin sent. */
export interface AccountLink {
  url: string;
  expiresAt: number;
  /** False when the server can't send email (no SMTP) or the send failed: pass `url` on yourself. */
  emailed: boolean;
  /** Why the email didn't go out, when it didn't. */
  error: string | null;
}

/** POST /users: the new user, and their invite when no password was set. */
export interface UserCreated {
  user: UserView;
  invite: AccountLink | null;
}

/** POST /auth/password-reset: always answers 200, whether or not the email has an account. */
export const PasswordResetRequest = z.object({ email: z.email().max(254) });
export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;

export const ACCOUNT_TOKEN_PURPOSES = ['invite', 'reset'] as const;
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];

/** GET /auth/account-token?token=…: what a set-password link is for, while it's still valid. */
export interface AccountTokenInfo {
  purpose: AccountTokenPurpose;
  email: string;
  name: string | null;
  expiresAt: number;
}

/** POST /auth/set-password: uses an invite or reset link once, and signs in. */
export const SetPasswordRequest = z.object({
  token: z.string().min(1).max(200),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(512),
  /** Invites only: the name to show for them. */
  name: z.string().max(120).optional(),
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequest>;

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
  /** Email a member when a ticket is assigned to them (needs SMTP). */
  notifyAssignees: boolean;
  /** Email the tester who left an address when their ticket is resolved, with the build it's fixed in. */
  notifyReporters: boolean;
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
    notifyAssignees: z.boolean(),
    notifyReporters: z.boolean(),
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

// ── Devices (SDK check-ins) ─────────────────────────────────────────────────

/** One install, from the config fetches its SDK made (feature `checkin`). */
export interface DeviceView {
  installId: string;
  platform: Platform;
  releaseType: ReleaseType;
  appId: string | null;
  appVersion: string | null;
  build: string | null;
  os: string | null;
  model: string | null;
  sdkVersion: string | null;
  wrapper: string | null;
  /** Release-type detection signals, `key=value;…` (docs/sdk-spec.md §3.1). */
  signals: string | null;
  /** false: the SDK stayed inert (an opt-in `unknown` ping). */
  active: boolean;
  health: 'ok' | 'crashloop' | null;
  /** Whether the config this install last received had Snitch enabled. */
  configEnabled: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
  checkins: number;
  reports: number;
}

/** Installs seen per app build, so a build whose SDK never checked in stands out. */
export interface BuildView {
  platform: Platform;
  appVersion: string;
  build: string;
  installs: number;
  /** Installs per detected release type. */
  releaseTypes: Partial<Record<ReleaseType, number>>;
  inactive: number;
  reports: number;
  lastSeenAt: number;
}

export interface DeviceList {
  items: DeviceView[];
  builds: BuildView[];
}

export const DeviceListQuery = z.object({
  platform: Platform.optional(),
  releaseType: ReleaseType.optional(),
  /** Only installs seen within this many days. */
  sinceDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type DeviceListQuery = z.infer<typeof DeviceListQuery>;

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
  /** The screen the report came from, when the SDK knew it. */
  screen: string | null;
  /** The build a fix shipped in, set when resolving. */
  fixedIn: string | null;
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
  /** The linked GitHub issue was closed or reopened; data: { integrationId, state, stateReason?, url, author? }. */
  'external_status_changed',
  /** A comment on the linked GitHub issue; data: { integrationId, body, author, url, externalId }. */
  'external_comment',
  /** An email went out; data: { to: 'assignee' | 'reporter', email }. */
  'notification_sent',
  /** data: { to, email, error }. */
  'notification_failed',
  /** The ticket was marked a duplicate; data: { duplicateOfId, key }. */
  'duplicate_marked',
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
  /** Open tickets that look like the same problem, best first. */
  similar: SimilarTicketView[];
}

export interface SimilarTicketView {
  id: string;
  key: string;
  title: string;
  status: TicketStatus;
  createdAt: number;
  /** 0–1. */
  score: number;
  /** Why it matched, e.g. "same screen", "same app version", "similar description". */
  reasons: string[];
}

export const TicketPatch = z
  .object({
    status: TicketStatus,
    assigneeUserId: z.string().nullable(),
    type: z.string().regex(REPORT_TYPE_ID),
    title: z.string().min(1).max(200),
    duplicateOfId: z.string().nullable(),
    fixedIn: z.string().trim().min(1).max(64).nullable(),
  })
  .partial();
export type TicketPatch = z.infer<typeof TicketPatch>;

const BulkIds = z.array(z.string().min(1).max(64)).min(1).max(200);

/** POST /tickets/bulk: one change to many tickets. Deleting needs an admin. */
export const TicketBulkRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), ids: BulkIds, assigneeUserId: z.string().nullable() }),
  z.object({ action: z.literal('status'), ids: BulkIds, status: TicketStatus }),
  z.object({ action: z.literal('escalate'), ids: BulkIds, integrationId: z.string().min(1) }),
  z.object({ action: z.literal('delete'), ids: BulkIds }),
]);
export type TicketBulkRequest = z.infer<typeof TicketBulkRequest>;
export type TicketBulkAction = TicketBulkRequest['action'];

export interface TicketBulkResult {
  /** Tickets the action changed (or queued, for escalate). */
  done: string[];
  /** Tickets left alone, and why: not found, already escalated, another project's integration, nothing to change. */
  skipped: { id: string; reason: string }[];
}

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
  /**
   * Two-way status: resolving / won't-fix / duplicate in Snitch closes the issue, reopening
   * reopens it; closing or reopening the issue on GitHub updates the ticket (needs the webhook).
   */
  syncStatus: z.boolean().default(false),
  /** Two-way comments: Snitch comments are posted to the issue; issue comments appear on the ticket (needs the webhook). */
  syncComments: z.boolean().default(false),
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
  /** GitHub only: where GitHub should send issue events, and whether a webhook secret exists. */
  webhook: { url: string; configured: boolean } | null;
  createdAt: number;
  updatedAt: number;
}

/** POST /integrations/:id/webhook-secret — a new signing secret, shown once. */
export interface WebhookSecretCreated {
  url: string;
  secret: string;
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

export interface BackupStatus {
  /** SNITCH_BACKUP_INTERVAL_HOURS > 0. */
  enabled: boolean;
  intervalHours: number;
  keep: number;
  /** `s3`: SNITCH_BACKUP_S3_* bucket; `storage`: the blob store under backups/ (same disk when it's fs). */
  target: 's3' | 'storage';
  lastAt: number | null;
  lastKey: string | null;
  lastBytes: number | null;
  lastError: string | null;
}

export interface ServerInfo {
  version: string;
  publicUrl: string;
  storage: 'fs' | 's3';
  mail: 'smtp' | 'console';
  backup: BackupStatus;
  features: string[];
}
