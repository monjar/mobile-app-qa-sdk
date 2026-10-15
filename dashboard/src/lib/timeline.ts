/**
 * Pure helpers for the report timeline panel (contract/src/timeline.ts): which
 * events a filter keeps, how runs of touches fold into one row, and how wall-clock
 * event times line up with the clip (meta.videoStart / videoEnd).
 */
import { NET_IN_FLIGHT, type TimelineEvent, type TimelineMeta, type TimelineNet } from '@snitch/contract';

/** Every composed clip is 10 fps (docs/sdk-spec.md §5.7), so one frame is 100 ms. */
export const CLIP_FPS = 10;

export type TimelineKind = TimelineEvent['k'];
export const TIMELINE_KINDS: readonly TimelineKind[] = ['log', 'net', 'screen', 'touch', 'app'];

/** Wall-clock times of the clip's first and last frame. */
export interface VideoSpan {
  start: number;
  end: number;
}

export function videoSpan(meta: TimelineMeta | null): VideoSpan | null {
  if (meta?.videoStart === undefined || meta.videoEnd === undefined || meta.videoEnd < meta.videoStart) return null;
  return { start: meta.videoStart, end: meta.videoEnd };
}

/** Seconds into the clip for a wall-clock time, or null when the clip doesn't cover it. */
export function toVideoTime(t: number, span: VideoSpan | null): number | null {
  if (!span || t < span.start || t > span.end) return null;
  return (t - span.start) / 1000;
}

export function toWallTime(seconds: number, span: VideoSpan): number {
  return span.start + seconds * 1000;
}

/** Still running when the report was opened (it may be the request that hangs). */
export function isInFlight(e: TimelineNet): boolean {
  return e.error === NET_IN_FLIGHT && e.status === undefined;
}

/** No response, a transport error, or a 4xx/5xx. A request still in flight counts too. */
export function isFailedRequest(e: TimelineNet): boolean {
  return e.error !== undefined || e.status === undefined || e.status >= 400;
}

export function isError(e: TimelineEvent): boolean {
  return (e.k === 'log' && e.level === 'error') || (e.k === 'net' && isFailedRequest(e));
}

function searchText(e: TimelineEvent): string {
  switch (e.k) {
    case 'log':
      return `${e.level} ${e.src} ${e.tag ?? ''} ${e.msg}`;
    case 'net':
      return `${e.method} ${e.url} ${e.status ?? ''} ${e.error ?? ''}`;
    case 'screen':
      return `screen ${e.name}`;
    case 'touch':
      return 'touch';
    case 'app':
      return `app ${e.event}`;
  }
}

export interface TimelineFilter {
  kinds: ReadonlySet<TimelineKind>;
  /** Error logs and failed requests only. */
  errorsOnly: boolean;
  query: string;
}

/** Indexes into `events` of the events the filter keeps, in order. */
export function filterEvents(events: readonly TimelineEvent[], f: TimelineFilter): number[] {
  const q = f.query.trim().toLowerCase();
  const out: number[] = [];
  events.forEach((e, i) => {
    if (!f.kinds.has(e.k)) return;
    if (f.errorsOnly && !isError(e)) return;
    if (q && !searchText(e).toLowerCase().includes(q)) return;
    out.push(i);
  });
  return out;
}

/** One row of the panel: a single event, or a run of consecutive touch downs folded into one. */
export interface TimelineItem {
  /** Index of the (first) event in the parsed list; stable across filter changes, so it doubles as the row key. */
  first: number;
  /** Indexes of the events the row covers. */
  indexes: number[];
  t: number;
}

export function buildItems(events: readonly TimelineEvent[], kept: readonly number[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const i of kept) {
    const e = events[i]!;
    const last = items[items.length - 1];
    if (e.k === 'touch' && last && events[last.first]!.k === 'touch') last.indexes.push(i);
    else items.push({ first: i, indexes: [i], t: e.t });
  }
  return items;
}

/** Index of the latest entry at or before `t` in a list sorted by time, or -1. */
export function latestAtOrBefore(list: readonly { t: number }[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Where a frame step lands: snapped to the frame grid, clamped to the clip. */
export function stepFrames(seconds: number, frames: number, duration: number): number {
  // The epsilon keeps 0.3 s (2.9999… frames in floating point) on frame 3.
  const frame = Math.floor(seconds * CLIP_FPS + 1e-6) + frames;
  return clamp(frame / CLIP_FPS, duration);
}

export function stepSeconds(seconds: number, delta: number, duration: number): number {
  return clamp(seconds + delta, duration);
}

function clamp(seconds: number, duration: number): number {
  return Math.min(Math.max(seconds, 0), Number.isFinite(duration) ? duration : Infinity);
}

/** `m:ss.s`, e.g. 0:03.2, or `h:mm:ss.s` from an hour on (a crash follow-up's log can be that old). */
export function clock(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const h = Math.floor(tenths / 36_000);
  const m = Math.floor((tenths % 36_000) / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Signed time from the report, e.g. −1:02.3 before it and +0:00.4 after. */
export function offset(ms: number): string {
  if (Math.round(Math.abs(ms) / 100) === 0) return '0:00.0';
  return `${ms < 0 ? '−' : '+'}${clock(Math.abs(ms) / 1000)}`;
}

/** Wall-clock time with milliseconds, for tooltips. */
export function wallClock(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
