/**
 * The SDK ↔ server contract: remote config, report intake and attachment upload.
 *
 * Upload is three steps so a flaky mobile connection can resume:
 *   1. POST /api/v1/reports                         — JSON; idempotent on clientReportId
 *   2. PUT  /api/v1/reports/:id/attachments/:name   — raw bytes per declared attachment
 *   3. POST /api/v1/reports/:id/complete            — 409 until every declared attachment is stored
 * A report the client never completes is swept after 24 h and marked `incomplete`.
 */
import { z } from 'zod';
import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_LIMITS,
  ATTACHMENT_NAME,
  CaptureMode,
  MAX_VIDEO_SECONDS,
  Platform,
  ReleaseType,
  SnapshotRenderer,
  Trigger,
  UploadState,
} from './enums';

export const API_PREFIX = '/api/v1';

/** Header names. Lowercase, as HTTP/2 sends them. */
export const HEADERS = {
  ingestKey: 'x-snitch-key',
  sdk: 'x-snitch-sdk',
  contentSha256: 'x-content-sha256',
  signature: 'x-snitch-signature',
  timestamp: 'x-snitch-timestamp',
  event: 'x-snitch-event',
} as const;

/** `snitch_pk_` + 26 Crockford base32 characters. Public, write-only, per project. */
export const INGEST_KEY_PATTERN = /^snitch_pk_[0-9A-HJKMNP-TV-Z]{26}$/;

export const REPORT_TYPE_ID = /^[a-z0-9_-]{1,24}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const str = (max: number) => z.string().max(max);

// ── Remote config ───────────────────────────────────────────────────────────

export const ReportTypeOption = z.object({
  id: z.string().regex(REPORT_TYPE_ID),
  label: z.string().min(1).max(40),
});
export type ReportTypeOption = z.infer<typeof ReportTypeOption>;

export const VideoConfig = z.object({
  enabled: z.boolean(),
  maxSeconds: z.number().int().min(1).max(MAX_VIDEO_SECONDS),
  captureMode: CaptureMode,
  /** iOS snapshot mode only. */
  snapshotRenderer: SnapshotRenderer,
  /** Snapshot frames per second while nobody is touching the screen. */
  idleFps: z.number().min(0.2).max(10),
  /** Snapshot frames per second for a short window after each touch. */
  activeFps: z.number().min(0.2).max(15),
  /** Frames per second kept from a system (ReplayKit / MediaProjection) capture. */
  systemFps: z.number().min(1).max(15),
  /** Cap on the share of main-thread time snapshot capture may use, in percent. */
  mainThreadBudgetPct: z.number().min(0.5).max(20),
});
export type VideoConfig = z.infer<typeof VideoConfig>;

export const SdkConfig = z.object({
  /** Off means: no gesture, no capture, no prompt. The SDK re-fetches after ttlSeconds. */
  enabled: z.boolean(),
  ttlSeconds: z.number().int().min(60).max(86_400),
  reportTypes: z.array(ReportTypeOption).min(1).max(8),
  screenshot: z.object({ enabled: z.boolean() }),
  video: VideoConfig,
  maskTextInputs: z.boolean(),
  /** Offer "Report this?" when the tester takes a system screenshot. */
  screenshotPrompt: z.boolean(),
  /** Optional one-line notice shown at the top of the report sheet. */
  message: z.string().max(500).nullable(),
});
export type SdkConfig = z.infer<typeof SdkConfig>;

export const DEFAULT_SDK_CONFIG: SdkConfig = {
  enabled: true,
  ttlSeconds: 3600,
  reportTypes: [
    { id: 'bug', label: 'Bug' },
    { id: 'idea', label: 'Idea' },
    { id: 'other', label: 'Other' },
  ],
  screenshot: { enabled: true },
  video: {
    enabled: true,
    maxSeconds: 30,
    captureMode: 'snapshot',
    snapshotRenderer: 'drawHierarchy',
    idleFps: 1,
    activeFps: 4,
    systemFps: 10,
    mainThreadBudgetPct: 3,
  },
  maskTextInputs: true,
  screenshotPrompt: true,
  message: null,
};

/** What a project stores per platform × release type: any subset, merged over the defaults. */
export const SdkConfigOverride = z
  .object({
    enabled: z.boolean(),
    ttlSeconds: SdkConfig.shape.ttlSeconds,
    reportTypes: SdkConfig.shape.reportTypes,
    screenshot: z.object({ enabled: z.boolean() }).partial(),
    video: VideoConfig.partial(),
    maskTextInputs: z.boolean(),
    screenshotPrompt: z.boolean(),
    message: SdkConfig.shape.message,
  })
  .partial();
export type SdkConfigOverride = z.infer<typeof SdkConfigOverride>;

/** Merge overrides left to right over a base config. Later wins; nested objects merge by key. */
export function mergeSdkConfig(base: SdkConfig, ...overrides: SdkConfigOverride[]): SdkConfig {
  let out: SdkConfig = { ...base, screenshot: { ...base.screenshot }, video: { ...base.video } };
  for (const o of overrides) {
    out = {
      ...out,
      ...stripUndefined(o),
      screenshot: { ...out.screenshot, ...stripUndefined(o.screenshot ?? {}) },
      video: { ...out.video, ...stripUndefined(o.video ?? {}) },
    };
  }
  return out;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const SdkConfigQuery = z.object({
  platform: Platform,
  releaseType: ReleaseType,
  appVersion: str(64).optional(),
  build: str(64).optional(),
  os: str(32).optional(),
  /** `crashloop` when the SDK suspects its capture crashed the app; the server may answer with capture off. */
  health: z.enum(['ok', 'crashloop']).optional(),
});
export type SdkConfigQuery = z.infer<typeof SdkConfigQuery>;

// ── Report intake ───────────────────────────────────────────────────────────

export const AttachmentDeclaration = z
  .object({
    name: z.string().regex(ATTACHMENT_NAME),
    contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256_HEX),
    width: z.number().int().positive().max(20_000).optional(),
    height: z.number().int().positive().max(20_000).optional(),
    durationMs: z
      .number()
      .int()
      .positive()
      .max((MAX_VIDEO_SECONDS + 1) * 1000)
      .optional(),
  })
  .refine((a) => a.sizeBytes <= ATTACHMENT_LIMITS[a.contentType], {
    message: 'attachment exceeds the size cap for its content type',
    path: ['sizeBytes'],
  });
export type AttachmentDeclaration = z.infer<typeof AttachmentDeclaration>;

export const DeviceInfo = z.object({
  platform: Platform,
  osVersion: str(32).min(1),
  model: str(64).min(1),
  manufacturer: str(64).optional(),
  locale: str(35).optional(),
  timeZone: str(64).optional(),
  screen: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      scale: z.number().positive().max(10),
      orientation: z.enum(['portrait', 'landscape']),
    })
    .optional(),
  memory: z
    .object({
      appMB: z.number().nonnegative().optional(),
      freeMB: z.number().nonnegative().optional(),
      totalMB: z.number().nonnegative().optional(),
    })
    .optional(),
  thermal: z.enum(['nominal', 'fair', 'serious', 'critical']).optional(),
  lowPower: z.boolean().optional(),
  battery: z.number().min(0).max(1).optional(),
  charging: z.boolean().optional(),
  network: z.enum(['wifi', 'cellular', 'ethernet', 'none', 'other', 'unknown']).optional(),
  darkMode: z.boolean().optional(),
  screenReader: z.boolean().optional(),
  fontScale: z.number().positive().max(10).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfo>;

export const AppInfo = z.object({
  /** Bundle id / application id. */
  id: str(255).min(1),
  name: str(120).optional(),
  version: str(64).min(1),
  build: str(64).min(1),
  releaseType: ReleaseType,
});
export type AppInfo = z.infer<typeof AppInfo>;

export const SdkInfo = z.object({
  name: str(64).min(1),
  version: str(32).min(1),
  wrapper: str(32).optional(),
  wrapperVersion: str(32).optional(),
});
export type SdkInfo = z.infer<typeof SdkInfo>;

/** Capture health the SDK measured on the device, so real-world cost is visible in the dashboard. */
export const CaptureStats = z
  .object({
    captureMode: CaptureMode.optional(),
    snapshotRenderer: SnapshotRenderer.optional(),
    captureMsP50: z.number().nonnegative().optional(),
    captureMsP95: z.number().nonnegative().optional(),
    effectiveFps: z.number().nonnegative().optional(),
    ringBytes: z.number().int().nonnegative().optional(),
    bufferedSeconds: z.number().nonnegative().optional(),
    composeMs: z.number().nonnegative().optional(),
    framesSkipped: z.number().int().nonnegative().optional(),
    uptimeSec: z.number().nonnegative().optional(),
    crashLoopDowngrades: z.number().int().nonnegative().optional(),
    videoLost: z.boolean().optional(),
  })
  .strict();
export type CaptureStats = z.infer<typeof CaptureStats>;

export const Reporter = z.object({
  email: z.email().max(254).optional(),
  name: str(120).optional(),
  id: str(200).optional(),
});
export type Reporter = z.infer<typeof Reporter>;

export const MAX_CUSTOM_KEYS = 50;

export const ReportCreate = z
  .object({
    clientReportId: z.uuid(),
    type: z.string().regex(REPORT_TYPE_ID),
    description: str(10_000),
    reporter: Reporter.optional(),
    reportedAt: z.iso.datetime({ offset: true }),
    trigger: Trigger,
    app: AppInfo,
    device: DeviceInfo,
    sdk: SdkInfo,
    custom: z
      .record(str(64), str(1000))
      .refine((r) => Object.keys(r).length <= MAX_CUSTOM_KEYS, { message: `at most ${MAX_CUSTOM_KEYS} custom keys` })
      .optional(),
    stats: CaptureStats.optional(),
    attachments: z.array(AttachmentDeclaration).max(5),
  })
  .refine((r) => new Set(r.attachments.map((a) => a.name)).size === r.attachments.length, {
    message: 'attachment names must be unique',
    path: ['attachments'],
  });
export type ReportCreate = z.infer<typeof ReportCreate>;

export const AttachmentState = z.enum(['missing', 'stored']);
export type AttachmentState = z.infer<typeof AttachmentState>;

export const ReportCreated = z.object({
  reportId: z.string(),
  /** Human ticket key, e.g. MOCH-42. */
  ticket: z.string(),
  number: z.number().int().positive(),
  state: UploadState,
  attachments: z.array(z.object({ name: z.string(), state: AttachmentState })),
});
export type ReportCreated = z.infer<typeof ReportCreated>;

export const AttachmentStored = z.object({
  name: z.string(),
  state: z.literal('stored'),
  sizeBytes: z.number().int().nonnegative(),
});
export type AttachmentStored = z.infer<typeof AttachmentStored>;

export const ReportCompleted = z.object({
  reportId: z.string(),
  ticket: z.string(),
  state: UploadState,
});
export type ReportCompleted = z.infer<typeof ReportCompleted>;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'release_type_not_allowed',
  'app_id_not_allowed',
  'not_found',
  'invalid_request',
  'length_required',
  'payload_too_large',
  'unsupported_media_type',
  'hash_mismatch',
  'magic_mismatch',
  'conflict',
  'attachments_missing',
  'report_completed',
  'rate_limited',
  'csrf',
  'internal',
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** Whether an SDK should keep a queued report and try again later after this error. */
export function isRetryable(status: number, code?: ErrorCode): boolean {
  if (status === 429 || status >= 500 || status === 0) return true;
  if (code === 'attachments_missing') return true;
  return false;
}
