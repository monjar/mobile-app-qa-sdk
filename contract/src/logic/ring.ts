/**
 * Reference implementation of the in-memory frame ring and of the frame
 * schedule used when composing a clip. Twins: Swift FrameRing/ClipSchedule,
 * Kotlin FrameRing/ClipSchedule. Vectors: contract/vectors/ring.json, compose.json.
 *
 * Frames are compressed stills with a timestamp. A frame is on screen from its
 * own timestamp until the next frame's, so to show the start of a window the
 * ring keeps the newest frame at or before that start, even though it is older
 * than the window.
 */

export interface RingFrame {
  t: number;
  size: number;
  checksum: string;
}

export class FrameRing<F extends RingFrame = RingFrame> {
  private items: F[] = [];
  private total = 0;

  constructor(
    readonly maxBytes: number,
    readonly maxAgeMs: number,
  ) {}

  /** Adds a frame; an exact repeat of the newest frame is dropped (the screen didn't change). */
  push(frame: F): boolean {
    const last = this.items[this.items.length - 1];
    if (last && last.checksum === frame.checksum) return false;
    this.items.push(frame);
    this.total += frame.size;
    this.evict();
    return true;
  }

  /** Drops the oldest half (memory warning). */
  trimHalf(): void {
    const drop = Math.floor(this.items.length / 2);
    for (let i = 0; i < drop; i++) this.total -= this.items[i]!.size;
    this.items = this.items.slice(drop);
  }

  clear(): void {
    this.items = [];
    this.total = 0;
  }

  get frames(): readonly F[] {
    return this.items;
  }

  get totalBytes(): number {
    return this.total;
  }

  /** How many milliseconds of history are available before `endT`. */
  bufferedMs(endT: number): number {
    const first = this.items[0];
    return first ? Math.max(0, endT - first.t) : 0;
  }

  /** Frames needed to show [endT - durationMs, endT]: the one on screen at the start, then every later one up to endT. */
  select(endT: number, durationMs: number): F[] {
    const start = endT - durationMs;
    let lead: F | undefined;
    const out: F[] = [];
    for (const f of this.items) {
      if (f.t > endT) break;
      if (f.t <= start) lead = f;
      else out.push(f);
    }
    return lead ? [lead, ...out] : out;
  }

  private evict(): void {
    while (this.items.length > 1 && this.total > this.maxBytes) {
      this.total -= this.items.shift()!.size;
    }
    const newest = this.items[this.items.length - 1];
    if (!newest) return;
    const cutoff = newest.t - this.maxAgeMs;
    while (this.items.length > 1 && this.items[1]!.t <= cutoff) {
      this.total -= this.items.shift()!.size;
    }
  }
}

/**
 * For a clip of [start, end) at `fps`, which source frame each output frame shows.
 * Output frame k is at start + k·(1000/fps); it shows the newest source frame at or
 * before that time, or the first source frame if none is that early. Returns
 * indexes into `frameTimes` (which must be ascending and non-empty).
 */
export function clipSchedule(frameTimes: readonly number[], start: number, end: number, fps: number): number[] {
  if (frameTimes.length === 0 || end <= start) return [];
  const step = 1000 / fps;
  const count = Math.max(1, Math.round((end - start) / step));
  const out: number[] = [];
  let src = 0;
  for (let k = 0; k < count; k++) {
    const t = start + k * step;
    while (src + 1 < frameTimes.length && frameTimes[src + 1]! <= t) src++;
    out.push(src);
  }
  return out;
}
