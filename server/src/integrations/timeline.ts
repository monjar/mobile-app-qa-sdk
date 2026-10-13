/**
 * "Before the report": the few timeline lines worth putting in a GitHub issue
 * or an email. The screen, then the latest error-level log lines and failed
 * requests, one line each. The full timeline stays in the dashboard.
 */
import { ATTACHMENT_LIMITS, parseTimeline, TIMELINE_ATTACHMENT, TIMELINE_CONTENT_TYPE, type ParsedTimeline } from '@snitch/contract';
import type { Deps } from '../deps';
import type { AttachmentRow, TicketRow } from '../repo/tickets';

export interface BeforeReport {
  screen: string | null;
  /** Oldest first, each one line. */
  lines: string[];
}

export const BEFORE_REPORT_LINES = 10;
const LINE_CHARS = 160;
/** Width of the `-4.2 s` column, so the lines line up in a monospace block. */
const TIME_COLUMN = 9;

export function oneLine(s: string, max = LINE_CHARS): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `-4.2 s` relative to the end of the timeline (or the report time). */
function ago(t: number, ref: number): string {
  const s = (t - ref) / 1000;
  return `${s > 0 ? '+' : s < 0 ? '-' : ''}${Math.abs(s).toFixed(1)} s`;
}

export function summarizeTimeline(t: ParsedTimeline, screen: string | null, reportedAt: number): BeforeReport {
  const ref = t.meta?.end ?? reportedAt;
  const picked: { t: number; text: string }[] = [];
  let lastScreen: string | null = null;
  for (const e of t.events) {
    if (e.k === 'screen') lastScreen = e.name;
    else if (e.k === 'log' && e.level === 'error') picked.push({ t: e.t, text: `error [${e.tag ?? e.src}] ${e.msg}` });
    else if (e.k === 'net' && ((e.status ?? 0) >= 400 || e.error !== undefined)) {
      const outcome = e.status !== undefined ? String(e.status) : 'failed';
      picked.push({ t: e.t, text: `${e.method} ${e.url} → ${outcome}${e.error ? `: ${e.error}` : ''}${e.ms !== undefined ? ` (${Math.round(e.ms)} ms)` : ''}` });
    }
  }
  const shownScreen = screen ?? lastScreen;
  return {
    screen: shownScreen ? oneLine(shownScreen) : null,
    lines: picked.slice(-BEFORE_REPORT_LINES).map((p) => `${`${ago(p.t, ref)} `.padEnd(TIME_COLUMN)}${oneLine(p.text, LINE_CHARS - TIME_COLUMN)}`),
  };
}

/**
 * Reads the ticket's timeline attachment, if it has one, and summarizes it.
 * Never fails an escalation: an unreadable timeline just leaves the section out.
 */
export async function loadBeforeReport(deps: Deps, ticket: TicketRow, attachments: AttachmentRow[]): Promise<BeforeReport | null> {
  const att = attachments.find((a) => a.name === TIMELINE_ATTACHMENT && a.content_type === TIMELINE_CONTENT_TYPE && a.state === 'stored');
  if (!att?.storage_key || (att.size_bytes ?? 0) > ATTACHMENT_LIMITS[TIMELINE_CONTENT_TYPE]) return null;
  try {
    const parsed = parseTimeline((await deps.blobs.readAll(att.storage_key)).toString('utf8'));
    if (!parsed.meta && parsed.events.length === 0) return null;
    return summarizeTimeline(parsed, ticket.screen, ticket.reported_at);
  } catch {
    return null;
  }
}
