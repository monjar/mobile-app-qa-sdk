/**
 * The report timeline (contract/src/timeline.ts): logs, requests, screens, touches
 * and app events from the minutes before the report. Events inside the clip seek
 * the video when clicked, and playback highlights (and scrolls to) the latest
 * event at or before the playhead.
 *
 * A timeline holds at most ~1000 events (TIMELINE_LIMITS), so every row renders,
 * without windowing: the list renders as a deferred (interruptible) pass, and rows
 * are memoized so playback only re-renders the rows whose highlight changes.
 * (`content-visibility: auto` on the rows made Chrome lay out once per row: slower.)
 */
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { parseTimeline, type AppEvent, type AttachmentView, type TimelineEvent, type TimelineLog, type TimelineNet } from '@snitch/contract';
import { errorText } from '../lib/api';
import { bytes } from '../lib/format';
import { useAttachmentText } from '../lib/queries';
import {
  TIMELINE_KINDS,
  buildItems,
  clock,
  filterEvents,
  isError,
  isFailedRequest,
  latestAtOrBefore,
  offset,
  toVideoTime,
  toWallTime,
  videoSpan,
  wallClock,
  type TimelineItem,
  type TimelineKind,
  type VideoSpan,
} from '../lib/timeline';
import type { Playhead } from './Player';
import { Chevron, Globe, Layers, Pointer, Terminal, Zap } from './icons';

const KIND_LABEL: Record<TimelineKind, string> = { log: 'Logs', net: 'Network', screen: 'Screens', touch: 'Touches', app: 'App' };
const KIND_ICON: Record<TimelineKind, typeof Terminal> = { log: Terminal, net: Globe, screen: Layers, touch: Pointer, app: Zap };
const APP_LABEL: Record<AppEvent, string> = {
  launch: 'App launched',
  foreground: 'Came to the foreground',
  background: 'Went to the background',
  memory_warning: 'Memory warning',
};
const NO_EVENTS: TimelineEvent[] = [];

export function TimelinePanel({ a, reportedAt, playhead, onSeek }: { a: AttachmentView; reportedAt: number; playhead: Playhead | null; onSeek: ((seconds: number) => void) | null }) {
  const text = useAttachmentText(a);
  const parsed = useMemo(() => (text.data === undefined ? null : parseTimeline(text.data)), [text.data]);
  const events = parsed?.events ?? NO_EVENTS;
  const meta = parsed?.meta ?? null;
  // Without a video there's nothing to line up with, so no event is "outside" either.
  const span = useMemo(() => (onSeek ? videoSpan(meta) : null), [onSeek, meta]);

  const [kinds, setKinds] = useState<ReadonlySet<TimelineKind>>(() => new Set(TIMELINE_KINDS));
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [query, setQuery] = useState('');
  // Rows render in a deferred, interruptible pass: a thousand of them don't block the page when the
  // timeline arrives, and the chips and search box respond at once while the list catches up.
  const latest = useMemo(() => ({ events, filter: { kinds, errorsOnly, query } }), [events, kinds, errorsOnly, query]);
  const view = useDeferredValue(latest);
  const pending = view !== latest;
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const listRef = useRef<HTMLOListElement>(null);

  const counts = useMemo(() => {
    const c: Record<TimelineKind | 'errors', number> = { log: 0, net: 0, screen: 0, touch: 0, app: 0, errors: 0 };
    for (const e of events) {
      c[e.k]++;
      if (isError(e)) c.errors++;
    }
    return c;
  }, [events]);
  const kept = useMemo(() => filterEvents(view.events, view.filter), [view]);
  const items = useMemo(() => buildItems(view.events, kept), [view, kept]);

  const wall = playhead && span ? toWallTime(playhead.time, span) : null;
  const currentItem = wall === null ? undefined : items[latestAtOrBefore(items, wall)];
  const currentKey = currentItem?.first ?? null;
  // Inside an expanded run of touches, the touch itself.
  const currentEvent = currentItem && wall !== null ? (currentItem.indexes.findLast((i) => view.events[i]!.t <= wall) ?? null) : null;

  useEffect(() => {
    const list = listRef.current;
    if (!follow || currentKey === null || !list) return;
    const row = list.querySelector<HTMLElement>(`[data-item="${currentKey}"]`);
    if (!row) return;
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTo({ top: Math.max(0, top - list.clientHeight / 3) });
  }, [currentKey, follow]);

  const toggleKind = (k: TimelineKind) =>
    setKinds((s) => {
      const next = new Set(s);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const toggleGroup = useCallback(
    (first: number) =>
      setExpanded((s) => {
        const next = new Set(s);
        if (!next.delete(first)) next.add(first);
        return next;
      }),
    [],
  );

  const rows = useMemo(
    () =>
      items.map((item) => (
        <Row
          key={item.first}
          item={item}
          events={view.events}
          current={item.first === currentKey}
          currentEvent={item.first === currentKey ? currentEvent : null}
          expanded={expanded.has(item.first)}
          onToggle={toggleGroup}
          span={span}
          reportedAt={reportedAt}
          onSeek={onSeek}
        />
      )),
    [items, view.events, currentKey, currentEvent, expanded, toggleGroup, span, reportedAt, onSeek],
  );

  return (
    <section className="card" aria-label="Timeline">
      <div className="card-header">
        <div>
          <h2>Timeline</h2>
          {parsed && (
            <div className="muted small" style={{ marginTop: 2 }}>
              {view.events === events && kept.length !== events.length ? `${kept.length} of ${events.length} events` : `${events.length} events`}
              {counts.errors > 0 && ` · ${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'}`}
            </div>
          )}
        </div>
        <a href={a.url} target="_blank" rel="noreferrer" className="small">
          Raw
        </a>
      </div>
      {text.isError ? (
        <div className="card-body error-text">Couldn't load the timeline: {errorText(text.error)}</div>
      ) : !parsed ? (
        <div className="card-body muted">Loading…</div>
      ) : events.length === 0 ? (
        <div className="card-body muted">The timeline is empty.</div>
      ) : (
        <>
          <div className="tl-toolbar">
            <div className="row wrap" role="group" aria-label="Event kinds" style={{ gap: 4 }}>
              {TIMELINE_KINDS.filter((k) => counts[k] > 0).map((k) => (
                <button key={k} type="button" className={`chip-toggle${kinds.has(k) ? ' on' : ''}`} aria-pressed={kinds.has(k)} onClick={() => toggleKind(k)}>
                  {KIND_LABEL[k]} <span className="count">{counts[k]}</span>
                </button>
              ))}
              <button type="button" className={`chip-toggle errors${errorsOnly ? ' on' : ''}`} aria-pressed={errorsOnly} onClick={() => setErrorsOnly((v) => !v)}>
                Errors only <span className="count">{counts.errors}</span>
              </button>
            </div>
            <span className="spacer" />
            <input type="search" className="tl-search" aria-label="Search the timeline" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
            {span && (
              <label className="check small">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                Follow video
              </label>
            )}
          </div>
          <TimelineNotes meta={meta} skipped={parsed.skipped} unaligned={!!onSeek && !span} />
          {items.length === 0 ? (
            <div className="card-body muted">{view.events === events ? 'No events match.' : 'Loading…'}</div>
          ) : (
            <ol className={`tl-list${pending ? ' pending' : ''}`} ref={listRef} aria-busy={pending}>
              {rows}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function TimelineNotes({ meta, skipped, unaligned }: { meta: { dropped?: number } | null; skipped: number; unaligned: boolean }) {
  const notes = [
    unaligned && "The timeline doesn't say when the video starts, so events can't be lined up with it.",
    !!meta?.dropped && `${meta.dropped} older events didn't fit on the device and were dropped.`,
    skipped > 0 && `${skipped} ${skipped === 1 ? "line wasn't" : "lines weren't"} readable (possibly from a newer SDK) and ${skipped === 1 ? 'is' : 'are'} not shown.`,
  ].filter(Boolean);
  if (notes.length === 0) return null;
  return (
    <div className="tl-notes muted small">
      {notes.map((n) => (
        <div key={n as string}>{n}</div>
      ))}
    </div>
  );
}

interface RowProps {
  item: TimelineItem;
  events: TimelineEvent[];
  current: boolean;
  currentEvent: number | null;
  expanded: boolean;
  onToggle: (first: number) => void;
  span: VideoSpan | null;
  reportedAt: number;
  onSeek: ((seconds: number) => void) | null;
}

const rowClass = (...flags: (string | false | null | undefined)[]) => ['tl-row', ...flags].filter(Boolean).join(' ');

/** One item; an expanded run of touches adds a row per touch right after it. */
const Row = memo(function Row({ item, events, current, currentEvent, expanded, onToggle, span, reportedAt, onSeek }: RowProps) {
  const e = events[item.first]!;
  const video = toVideoTime(item.t, span);
  const seek = video !== null && onSeek ? () => onSeek(video) : undefined;
  const Icon = KIND_ICON[e.k];
  const group = item.indexes.length > 1;
  return (
    <>
      <li
        data-item={item.first}
        className={rowClass(current && 'current', span && video === null && 'outside', seek && 'seekable', isError(e) && 'error')}
        aria-current={current || undefined}
        onClick={seek && rowClick(seek)}
      >
        <Time t={item.t} reportedAt={reportedAt} video={video} onSeek={seek} />
        <Icon className="tl-icon" />
        <div className="tl-body">
          {e.k === 'log' && <LogBody e={e} />}
          {e.k === 'net' && <NetBody e={e} />}
          {e.k === 'screen' && (
            <div>
              Screen <strong>{e.name}</strong>{' '}
              <span className="chip" title={e.src === 'app' ? 'Named by the app' : 'Inferred by the SDK'}>
                {e.src}
              </span>
            </div>
          )}
          {e.k === 'app' && <div className={e.event === 'memory_warning' ? 'warn-text' : undefined}>{APP_LABEL[e.event]}</div>}
          {e.k === 'touch' &&
            (group ? (
              <button type="button" className="link-button" aria-expanded={expanded} onClick={() => onToggle(item.first)}>
                <Chevron className={`icon-inline disclosure${expanded ? ' open' : ''}`} /> {item.indexes.length} touches
                <span className="muted"> over {clock((events[item.indexes[item.indexes.length - 1]!]!.t - item.t) / 1000)}</span>
              </button>
            ) : (
              <TouchText e={e} />
            ))}
        </div>
      </li>
      {group &&
        expanded &&
        item.indexes.map((i) => {
          const touch = events[i]!;
          const v = toVideoTime(touch.t, span);
          const seekTouch = v !== null && onSeek ? () => onSeek(v) : undefined;
          return (
            <li key={i} className={rowClass('sub', currentEvent === i && 'current', span && v === null && 'outside', seekTouch && 'seekable')} onClick={seekTouch && rowClick(seekTouch)}>
              <Time t={touch.t} reportedAt={reportedAt} video={v} onSeek={seekTouch} />
              <span />
              <TouchText e={touch} />
            </li>
          );
        })}
    </>
  );
});

/** Clicking anywhere on a row seeks, except on its own controls or while selecting text. */
const rowClick = (seek: () => void) => (e: MouseEvent) => {
  if ((e.target as HTMLElement).closest('button, a, input')) return;
  if (window.getSelection()?.toString()) return;
  seek();
};

function Time({ t, reportedAt, video, onSeek }: { t: number; reportedAt: number; video: number | null; onSeek: (() => void) | undefined }) {
  const fromReport = offset(t - reportedAt);
  const inner = (
    <>
      <span>{fromReport}</span>
      {video !== null && <span className="tl-video-time">▶ {clock(video)}</span>}
    </>
  );
  return onSeek ? (
    <button type="button" className="tl-time" title={`${wallClock(t)} · play from here`} aria-label={`Play from ${clock(video!)} (${fromReport} from the report)`} onClick={onSeek}>
      {inner}
    </button>
  ) : (
    <span className="tl-time" title={wallClock(t)}>
      {inner}
    </span>
  );
}

/** Messages longer than this (or than a few lines) start collapsed. */
const LONG_MESSAGE = 280;

function LogBody({ e }: { e: TimelineLog }) {
  const long = e.msg.length > LONG_MESSAGE || e.msg.split('\n', 5).length > 4;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={`tl-msg${long && !open ? ' clamped' : ''}`}>
        <span className={`tl-level ${e.level}`}>{e.level}</span> <span className="chip">{e.src}</span> {e.tag && <span className="tl-tag">{e.tag}</span>} <span className={`lvl-${e.level}`}>{e.msg}</span>
      </div>
      {long && (
        <button type="button" className="link-button small" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

function NetBody({ e }: { e: TimelineNet }) {
  const failed = isFailedRequest(e);
  return (
    <>
      <div className="tl-msg">
        <span className="tl-method">{e.method}</span> <span className="tl-url">{e.url}</span>
      </div>
      <div className="tl-meta">
        {e.status !== undefined ? <span className={`tl-status s${Math.floor(e.status / 100)}`}>{e.status}</span> : <span className="tl-status s5">No response</span>}
        {e.ms !== undefined && <span>{e.ms < 1000 ? `${Math.round(e.ms)} ms` : `${(e.ms / 1000).toFixed(1)} s`}</span>}
        {e.reqBytes !== undefined && <span title="Request body">↑ {bytes(e.reqBytes)}</span>}
        {e.resBytes !== undefined && <span title="Response body">↓ {bytes(e.resBytes)}</span>}
        {e.error && <span className={failed ? 'error-text' : undefined}>{e.error}</span>}
      </div>
    </>
  );
}

function TouchText({ e }: { e: TimelineEvent }) {
  if (e.k !== 'touch') return null;
  return (
    <span>
      Touch at {Math.round(e.x * 100)}%, {Math.round(e.y * 100)}%{e.n && e.n > 1 ? ` · ${e.n} fingers` : ''}
    </span>
  );
}
