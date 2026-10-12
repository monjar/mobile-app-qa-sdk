/**
 * The report timeline: what happened in the app around the report, sent as the
 * `timeline` attachment (`application/x-ndjson`, one JSON object per line).
 *
 * The first line is a `meta` record; every other line is an event with `t`, the
 * wall-clock time in epoch milliseconds. Events are in time order. The dashboard
 * lines them up with the video using `meta.videoStart` / `meta.videoEnd`, the
 * wall-clock times of the clip's first and last frame.
 *
 * Readers are lenient: a line that doesn't parse is skipped, never fatal, so an
 * SDK one version ahead can add fields or kinds.
 */
import { z } from 'zod';
import { Platform } from './enums';

export const TIMELINE_ATTACHMENT = 'timeline';
export const TIMELINE_CONTENT_TYPE = 'application/x-ndjson';

/** What an SDK keeps in memory, newest wins. */
export const TIMELINE_LIMITS = {
  logs: 500,
  network: 100,
  screens: 50,
  touches: 300,
  app: 50,
  /** Characters per log message; longer ones are cut and end with `…`. */
  msgChars: 2000,
  /** UTF-16 code units per sanitized URL. */
  urlChars: 500,
  /** How far back the timeline reaches, in milliseconds. */
  maxAgeMs: 5 * 60 * 1000,
} as const;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevel = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevel>;

/**
 * - app     — Snitch.log / the app's log provider
 * - js      — React Native JavaScript console
 * - native  — iOS unified log (os_log / NSLog) of this process
 * - logcat  — Android logcat of this process
 * - sdk     — Snitch's own diagnostics
 */
export const LOG_SOURCES = ['app', 'js', 'native', 'logcat', 'sdk'] as const;
export const LogSource = z.enum(LOG_SOURCES);
export type LogSource = z.infer<typeof LogSource>;

export const APP_EVENTS = ['launch', 'foreground', 'background', 'memory_warning'] as const;
export const AppEvent = z.enum(APP_EVENTS);
export type AppEvent = z.infer<typeof AppEvent>;

const epochMs = z.number().int().nonnegative();

export const TimelineMeta = z.object({
  k: z.literal('meta'),
  v: z.literal(1),
  platform: Platform,
  /** Wall-clock span the events cover. */
  start: epochMs,
  end: epochMs,
  /** Wall-clock time of the video's first and last frame, when the report has a video. */
  videoStart: epochMs.optional(),
  videoEnd: epochMs.optional(),
  /** Events dropped because a ring was full. */
  dropped: z.number().int().nonnegative().optional(),
});
export type TimelineMeta = z.infer<typeof TimelineMeta>;

export const TimelineLog = z.object({
  k: z.literal('log'),
  t: epochMs,
  level: LogLevel,
  src: LogSource,
  msg: z.string().max(TIMELINE_LIMITS.msgChars),
  /** Logger subsystem / logcat tag. */
  tag: z.string().max(64).optional(),
});

export const TimelineNet = z.object({
  k: z.literal('net'),
  /** When the request started. */
  t: epochMs,
  method: z.string().min(1).max(16),
  /** Sanitized: no credentials, no fragment, query values replaced (sanitizeUrl). */
  url: z.string().max(TIMELINE_LIMITS.urlChars),
  /** HTTP status; absent when the request failed without a response. */
  status: z.number().int().min(100).max(999).optional(),
  /** Duration to the end of the response (or the failure). */
  ms: z.number().nonnegative().optional(),
  reqBytes: z.number().int().nonnegative().optional(),
  resBytes: z.number().int().nonnegative().optional(),
  error: z.string().max(300).optional(),
});

export const TimelineScreen = z.object({
  k: z.literal('screen'),
  t: epochMs,
  name: z.string().min(1).max(200),
  /** `app` when the app named it (Snitch.setScreen, router hooks), `native` when the SDK inferred it. */
  src: z.enum(['app', 'native']),
});

export const TimelineTouch = z.object({
  k: z.literal('touch'),
  t: epochMs,
  /** Where a finger went down, as a fraction of the screen. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  /** Fingers down at that moment. */
  n: z.number().int().min(1).max(20).optional(),
});

export const TimelineApp = z.object({
  k: z.literal('app'),
  t: epochMs,
  event: AppEvent,
});

export const TimelineEvent = z.discriminatedUnion('k', [TimelineLog, TimelineNet, TimelineScreen, TimelineTouch, TimelineApp]);
export type TimelineEvent = z.infer<typeof TimelineEvent>;
export type TimelineLog = z.infer<typeof TimelineLog>;
export type TimelineNet = z.infer<typeof TimelineNet>;
export type TimelineScreen = z.infer<typeof TimelineScreen>;
export type TimelineTouch = z.infer<typeof TimelineTouch>;
export type TimelineApp = z.infer<typeof TimelineApp>;

export interface ParsedTimeline {
  meta: TimelineMeta | null;
  events: TimelineEvent[];
  /** Lines that were not valid JSON or not a known record. */
  skipped: number;
}

/** Parses timeline ndjson leniently: bad lines are counted and skipped; events come back sorted by `t`. */
export function parseTimeline(text: string): ParsedTimeline {
  let meta: TimelineMeta | null = null;
  const events: TimelineEvent[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!meta && (value as { k?: unknown } | null)?.k === 'meta') {
      const m = TimelineMeta.safeParse(value);
      if (m.success) meta = m.data;
      else skipped++;
      continue;
    }
    const e = TimelineEvent.safeParse(value);
    if (e.success) events.push(e.data);
    else skipped++;
  }
  events.sort((a, b) => a.t - b.t);
  return { meta, events, skipped };
}

/**
 * The URL form a timeline stores (vectors: contract/vectors/url-sanitize.json).
 * Plain string surgery, so Swift and Kotlin give byte-identical results:
 *
 *   1. No `scheme:` prefix → `…`. A scheme other than http/https, or no `//`
 *      after it → `<scheme>:…` (scheme lowercased).
 *   2. Cut at the first `#`.
 *   3. Authority = after `//` up to the first `/` or `?`; drop everything up to the
 *      last `@` (credentials); lowercase it. Empty → `<scheme>:…`.
 *   4. Path = from that `/` up to the first `?`, as sent (no decoding or
 *      normalising); `/` when there is none.
 *   5. Query: split on `&`, skip empty parts, keep each name (text before the
 *      first `=`) as `name=*`.
 *   6. Longer than TIMELINE_LIMITS.urlChars UTF-16 code units → the first (limit − 1) plus `…`.
 */
export function sanitizeUrl(input: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
  if (!m) return '…';
  const scheme = m[1]!.toLowerCase();
  let rest = input.slice(m[0].length);
  if ((scheme !== 'http' && scheme !== 'https') || !rest.startsWith('//')) return `${scheme}:…`;
  rest = rest.slice(2);
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  let authorityEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '/' || rest[i] === '?') {
      authorityEnd = i;
      break;
    }
  }
  let authority = rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  authority = authority.toLowerCase();
  if (!authority) return `${scheme}:…`;
  const tail = rest.slice(authorityEnd);
  const q = tail.indexOf('?');
  const path = (q >= 0 ? tail.slice(0, q) : tail) || '/';
  const names = q >= 0 ? tail.slice(q + 1).split('&').filter((p) => p.length > 0).map((p) => `${p.split('=')[0]}=*`) : [];
  const out = `${scheme}://${authority}${path}${names.length ? `?${names.join('&')}` : ''}`;
  return out.length > TIMELINE_LIMITS.urlChars ? `${out.slice(0, TIMELINE_LIMITS.urlChars - 1)}…` : out;
}
