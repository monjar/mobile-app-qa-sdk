import { describe, expect, it } from 'vitest';
import { parseTimeline, type TimelineEvent } from '@snitch/contract';
import fixture from '../../../contract/fixtures/timeline.ndjson?raw';
import {
  TIMELINE_KINDS,
  buildItems,
  clock,
  filterEvents,
  isError,
  latestAtOrBefore,
  offset,
  stepFrames,
  stepSeconds,
  toVideoTime,
  toWallTime,
  videoSpan,
} from './timeline';

const parsed = parseTimeline(fixture);
const all = { kinds: new Set(TIMELINE_KINDS), errorsOnly: false, query: '' };

describe('video span', () => {
  const span = videoSpan(parsed.meta)!;

  it('comes from meta.videoStart / videoEnd', () => {
    expect(span).toEqual({ start: 1791381287120, end: 1791381302120 });
    expect(videoSpan(null)).toBeNull();
    expect(videoSpan({ ...parsed.meta!, videoStart: undefined })).toBeNull();
  });

  it('maps wall-clock times into the clip and back', () => {
    expect(toVideoTime(span.start, span)).toBe(0);
    expect(toVideoTime(1791381295000, span)).toBeCloseTo(7.88);
    expect(toVideoTime(span.end, span)).toBe(15);
    expect(toVideoTime(span.start - 1, span)).toBeNull();
    expect(toVideoTime(span.end + 1, span)).toBeNull();
    expect(toVideoTime(span.start, null)).toBeNull();
    expect(toWallTime(7.88, span)).toBe(1791381295000);
  });
});

describe('filtering', () => {
  it('keeps every known event by default', () => {
    expect(filterEvents(parsed.events, all)).toHaveLength(parsed.events.length);
  });

  it('narrows by kind, errors and text', () => {
    const kinds = (idx: number[]) => idx.map((i) => parsed.events[i]!.k);
    expect(kinds(filterEvents(parsed.events, { ...all, kinds: new Set(['net']) }))).toEqual(['net', 'net']);
    // An error log and the request that timed out; the 200 and the warning stay out.
    const errors = filterEvents(parsed.events, { ...all, errorsOnly: true }).map((i) => parsed.events[i]!);
    expect(errors.map((e) => e.k)).toEqual(['net', 'log']);
    expect(errors.every(isError)).toBe(true);
    expect(filterEvents(parsed.events, { ...all, query: 'TIMED OUT' })).toHaveLength(2);
    expect(filterEvents(parsed.events, { ...all, query: 'onboarding' }).map((i) => parsed.events[i]!.k)).toEqual(['screen']);
  });

  it('treats a request without a status as failed', () => {
    const net = (o: object): TimelineEvent => ({ k: 'net', t: 1, method: 'GET', url: 'https://x/', ...o }) as TimelineEvent;
    expect(isError(net({ status: 200 }))).toBe(false);
    expect(isError(net({ status: 302 }))).toBe(false);
    expect(isError(net({ status: 404 }))).toBe(true);
    expect(isError(net({}))).toBe(true);
    expect(isError(net({ status: 200, error: 'cancelled' }))).toBe(true);
  });
});

describe('items', () => {
  const touch = (t: number): TimelineEvent => ({ k: 'touch', t, x: 0.5, y: 0.5 });
  const screen = (t: number): TimelineEvent => ({ k: 'screen', t, name: 's', src: 'app' });
  const events = [touch(1), touch(2), touch(3), screen(4), touch(5)];

  it('folds consecutive touches into one row', () => {
    expect(buildItems(events, [0, 1, 2, 3, 4]).map((i) => i.indexes)).toEqual([[0, 1, 2], [3], [4]]);
  });

  it('folds touches that become adjacent once other events are filtered out', () => {
    expect(buildItems(events, [0, 1, 2, 4]).map((i) => i.indexes)).toEqual([[0, 1, 2, 4]]);
  });

  it('finds the latest row at or before the playhead', () => {
    const items = buildItems(events, [0, 1, 2, 3, 4]);
    expect(latestAtOrBefore(items, 0)).toBe(-1);
    expect(latestAtOrBefore(items, 1)).toBe(0);
    expect(latestAtOrBefore(items, 3.9)).toBe(0);
    expect(latestAtOrBefore(items, 4)).toBe(1);
    expect(latestAtOrBefore(items, 99)).toBe(2);
    expect(latestAtOrBefore([], 5)).toBe(-1);
  });
});

describe('stepping', () => {
  it('moves one 100 ms frame, snapped to the frame grid', () => {
    expect(stepFrames(0, 1, 15)).toBe(0.1);
    expect(stepFrames(0.3, 1, 15)).toBe(0.4);
    expect(stepFrames(0.15, 1, 15)).toBe(0.2);
    expect(stepFrames(0.15, -1, 15)).toBe(0);
    expect(stepFrames(0, -1, 15)).toBe(0);
    expect(stepFrames(15, 1, 15)).toBe(15);
    expect(stepFrames(2, 1, NaN)).toBe(2.1);
  });

  it('moves whole seconds within the clip', () => {
    expect(stepSeconds(0.5, -1, 15)).toBe(0);
    expect(stepSeconds(14.5, 1, 15)).toBe(15);
    expect(stepSeconds(3, 1, 15)).toBe(4);
  });
});

describe('formatting', () => {
  it('formats clip times and offsets from the report', () => {
    expect(clock(0)).toBe('0:00.0');
    expect(clock(3.24)).toBe('0:03.2');
    expect(clock(75.06)).toBe('1:15.1');
    expect(clock(3723.4)).toBe('1:02:03.4');
    expect(offset(-62_300)).toBe('−1:02.3');
    expect(offset(400)).toBe('+0:00.4');
    expect(offset(-20)).toBe('0:00.0');
  });
});
