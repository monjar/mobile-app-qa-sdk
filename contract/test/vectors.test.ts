import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNOR_CONFIG,
  FrameRing,
  ThreeFingerHoldDetector,
  classifyAndroid,
  classifyIos,
  clipSchedule,
  nextCaptureDelayMs,
  updateAverageCost,
  type DetectorEvent,
  type GovernorInput,
} from '../src/logic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vectors = (name: string): any => JSON.parse(readFileSync(join(__dirname, '..', 'vectors', name), 'utf8'));

describe('gesture vectors', () => {
  const v = vectors('gesture.json');
  for (const c of v.cases) {
    it(c.name, () => {
      const d = new ThreeFingerHoldDetector(c.config ?? {});
      const fires: number[] = [];
      for (const e of c.events as DetectorEvent[]) if (d.handle(e)) fires.push(e.t);
      expect(fires).toEqual(c.fires);
    });
  }
});

describe('governor vectors', () => {
  const v = vectors('governor.json');
  for (const c of v.cases) {
    it(c.name, () => {
      const config = { ...DEFAULT_GOVERNOR_CONFIG, ...(c.config ?? {}) };
      expect(nextCaptureDelayMs(config, c.input as GovernorInput)).toBe(c.delayMs);
    });
  }
  it('ewma', () => {
    let avg: number | null = null;
    const got: number[] = [];
    for (const s of v.ewma.samples as number[]) {
      avg = updateAverageCost(avg, s);
      got.push(avg);
    }
    (v.ewma.expect as number[]).forEach((e, i) => expect(got[i]).toBeCloseTo(e, 9));
  });
});

describe('ring vectors', () => {
  const v = vectors('ring.json');
  for (const c of v.cases) {
    it(c.name, () => {
      const ring = new FrameRing(c.maxBytes, c.maxAgeMs);
      for (const op of c.ops) {
        switch (op.op) {
          case 'push':
            ring.push({ t: op.t, size: op.size, checksum: op.checksum });
            break;
          case 'expect':
            expect(ring.frames.map((f) => f.t)).toEqual(op.ts);
            expect(ring.totalBytes).toBe(op.totalBytes);
            break;
          case 'select':
            expect(ring.select(op.endT, op.durationMs).map((f) => f.t)).toEqual(op.ts);
            break;
          case 'trimHalf':
            ring.trimHalf();
            break;
          case 'buffered':
            expect(ring.bufferedMs(op.endT)).toBe(op.ms);
            break;
          default:
            throw new Error(`unknown op ${op.op}`);
        }
      }
    });
  }
});

describe('compose vectors', () => {
  const v = vectors('compose.json');
  for (const c of v.cases) {
    it(c.name, () => expect(clipSchedule(c.frameTimes, c.start, c.end, c.fps)).toEqual(c.expect));
  }
});

describe('release type vectors', () => {
  const v = vectors('release-type.json');
  for (const c of v.ios) it(`ios: ${c.name}`, () => expect(classifyIos(c.signals)).toBe(c.expect));
  for (const c of v.android) it(`android: ${c.name}`, () => expect(classifyAndroid(c.signals)).toBe(c.expect));
});
