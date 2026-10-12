/**
 * Closed vocabularies shared by the SDKs, the server and the dashboard.
 *
 * These strings go over the wire and into the database, so they never change
 * meaning: add new values, don't rename old ones.
 */
import { z } from 'zod';

export const PLATFORMS = ['ios', 'android'] as const;
export const Platform = z.enum(PLATFORMS);
export type Platform = z.infer<typeof Platform>;

/**
 * How the running build was distributed, as the SDK detects it at runtime.
 *
 * - debug       — attached to a debugger / development-signed (get-task-allow, FLAG_DEBUGGABLE), or a simulator
 * - adhoc       — iOS ad-hoc profile with a device list
 * - enterprise  — iOS in-house profile (ProvisionsAllDevices)
 * - testflight  — iOS store-signed with a sandbox receipt
 * - appstore    — iOS store-signed with a production receipt
 * - internal    — Android release build not installed from a public store (sideload, Firebase, MDM)
 * - play        — Android build installed from a public store (Google Play and other known stores)
 * - unknown     — detection could not decide; treated as disabled everywhere
 */
export const RELEASE_TYPES = ['debug', 'adhoc', 'enterprise', 'testflight', 'appstore', 'internal', 'play', 'unknown'] as const;
export const ReleaseType = z.enum(RELEASE_TYPES);
export type ReleaseType = z.infer<typeof ReleaseType>;

/** What an SDK enables when the app doesn't say otherwise: every pre-release channel. */
export const DEFAULT_ENABLED_RELEASE_TYPES: readonly ReleaseType[] = ['debug', 'adhoc', 'enterprise', 'testflight', 'internal'];

export const TICKET_STATUSES = ['new', 'triaged', 'in_progress', 'resolved', 'wont_fix', 'duplicate'] as const;
export const TicketStatus = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** Whether every attachment a report declared has arrived. */
export const UPLOAD_STATES = ['pending', 'complete', 'incomplete'] as const;
export const UploadState = z.enum(UPLOAD_STATES);
export type UploadState = z.infer<typeof UploadState>;

/**
 * What opened the report sheet. `crash` is the follow-up offered on the launch
 * after an unexpected exit; SDKs only send it to servers that list the
 * `trigger-crash` feature (older servers reject unknown triggers).
 */
export const TRIGGERS = ['gesture', 'screenshot', 'shake', 'api', 'crash'] as const;
export const Trigger = z.enum(TRIGGERS);
export type Trigger = z.infer<typeof Trigger>;

/**
 * Where video frames come from.
 * - snapshot — the SDK draws the app's own windows a few times a second; no permission prompt
 * - system   — ReplayKit / MediaProjection; full frame rate, OS consent prompt each session
 * - off      — no video; screenshots still work
 */
export const CAPTURE_MODES = ['snapshot', 'system', 'off'] as const;
export const CaptureMode = z.enum(CAPTURE_MODES);
export type CaptureMode = z.infer<typeof CaptureMode>;

/** iOS only: how snapshot mode renders a window. layerRender misses Metal content but avoids drawHierarchy. */
export const SNAPSHOT_RENDERERS = ['drawHierarchy', 'layerRender'] as const;
export const SnapshotRenderer = z.enum(SNAPSHOT_RENDERERS);
export type SnapshotRenderer = z.infer<typeof SnapshotRenderer>;

export const INTEGRATION_KINDS = ['github', 'email', 'webhook'] as const;
export const IntegrationKind = z.enum(INTEGRATION_KINDS);
export type IntegrationKind = z.infer<typeof IntegrationKind>;

export const ESCALATION_STATES = ['queued', 'sent', 'failed'] as const;
export const EscalationState = z.enum(ESCALATION_STATES);
export type EscalationState = z.infer<typeof EscalationState>;

export const USER_ROLES = ['admin', 'member'] as const;
export const UserRole = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRole>;

/** Attachment names a report may declare: lowercase slug. */
export const ATTACHMENT_NAME = /^[a-z0-9_-]{1,32}$/;

/** Content types the server will store, with their size caps in bytes. */
export const ATTACHMENT_LIMITS = {
  'image/jpeg': 8 * 1024 * 1024,
  'image/png': 8 * 1024 * 1024,
  'video/mp4': 30 * 1024 * 1024,
  'text/plain': 2 * 1024 * 1024,
  /** The report timeline (contract/src/timeline.ts). */
  'application/x-ndjson': 2 * 1024 * 1024,
} as const satisfies Record<string, number>;
export type AttachmentContentType = keyof typeof ATTACHMENT_LIMITS;
export const ATTACHMENT_CONTENT_TYPES = Object.keys(ATTACHMENT_LIMITS) as [AttachmentContentType, ...AttachmentContentType[]];

/** The longest clip a report may carry. */
export const MAX_VIDEO_SECONDS = 30;

/** Most attachments one report may declare (screenshot, video, logs, timeline, crash, and room to grow). */
export const MAX_ATTACHMENTS = 8;

/**
 * What a server can do beyond the 0.1 protocol, listed in the remote config's
 * `features`. SDKs check this before using anything an older server would reject.
 *
 * - resumable-upload — attachment PUTs accept Content-Range chunks (§ chunked upload in ingest.ts)
 * - timeline         — the server parses and shows the `timeline` attachment
 * - trigger-crash    — ReportCreate.trigger may be `crash`
 * - checkin          — config fetches carrying installId are recorded as device check-ins
 */
export const SERVER_FEATURES = ['resumable-upload', 'timeline', 'trigger-crash', 'checkin'] as const;
export type ServerFeature = (typeof SERVER_FEATURES)[number];
