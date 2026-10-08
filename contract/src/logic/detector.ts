/**
 * Reference implementation of the trigger gesture: a still, three-finger hold.
 *
 * The Swift and Kotlin SDKs carry line-for-line twins of this state machine and
 * are tested against the same vectors (contract/vectors/gesture.json), so the
 * three must stay in step. Keep it pure: no clocks, no platform types.
 *
 * Rules, with the defaults:
 * - exactly `pointers` (3) touches, every one landing within `landingWindowMs` (250) of the first
 * - none moving more than `slop` (10 pt/dp) from where it landed
 * - fires once `holdMs` (250) has passed since the last finger landed, so at most
 *   landingWindowMs + holdMs (500 ms) after the first touch — no later than the 500 ms
 *   default long-press most apps use
 * - any lift, a fourth finger, or too much movement fails the sequence until every finger is up
 * - one fire per sequence, and none within `cooldownMs` (1000) of the previous fire
 */

export interface DetectorConfig {
  pointers: number;
  landingWindowMs: number;
  holdMs: number;
  slop: number;
  cooldownMs: number;
  enabled: boolean;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  pointers: 3,
  landingWindowMs: 250,
  holdMs: 250,
  slop: 10,
  cooldownMs: 1000,
  enabled: true,
};

export type DetectorEvent =
  | { t: number; type: 'down' | 'move' | 'up' | 'cancel'; id: number; x: number; y: number }
  | { t: number; type: 'tick' };

export class ThreeFingerHoldDetector {
  readonly config: DetectorConfig;
  private readonly origins = new Map<number, { x: number; y: number }>();
  private firstDownT = 0;
  private armedAt: number | null = null;
  private failed = false;
  private fired = false;
  private lastFireT = Number.NEGATIVE_INFINITY;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  }

  /** Feed one event; returns true exactly when the gesture fires. */
  handle(e: DetectorEvent): boolean {
    switch (e.type) {
      case 'down': {
        if (this.origins.size === 0) this.resetSequence(e.t);
        this.origins.set(e.id, { x: e.x, y: e.y });
        const n = this.origins.size;
        if (n > this.config.pointers) this.failed = true;
        else if (n === this.config.pointers) {
          if (e.t - this.firstDownT > this.config.landingWindowMs) this.failed = true;
          else this.armedAt = e.t;
        }
        break;
      }
      case 'move': {
        const o = this.origins.get(e.id);
        if (o) {
          const dx = e.x - o.x;
          const dy = e.y - o.y;
          if (dx * dx + dy * dy > this.config.slop * this.config.slop) this.failed = true;
        }
        break;
      }
      case 'up':
      case 'cancel': {
        if (this.origins.delete(e.id)) {
          if (!this.fired) this.failed = true;
          if (this.origins.size === 0) this.resetSequence(e.t);
        }
        return false;
      }
      case 'tick':
        break;
    }
    return this.check(e.t);
  }

  /** True while a sequence that has already fired still has fingers down — the SDK swallows those touches. */
  get isConsumingSequence(): boolean {
    return this.fired && this.origins.size > 0;
  }

  get activeTouches(): number {
    return this.origins.size;
  }

  private check(t: number): boolean {
    const c = this.config;
    if (!c.enabled || this.failed || this.fired || this.armedAt === null) return false;
    if (this.origins.size !== c.pointers) return false;
    if (t - this.armedAt < c.holdMs) return false;
    if (t - this.lastFireT < c.cooldownMs) {
      this.failed = true;
      return false;
    }
    this.fired = true;
    this.lastFireT = t;
    return true;
  }

  private resetSequence(t: number): void {
    this.firstDownT = t;
    this.armedAt = null;
    this.failed = false;
    this.fired = false;
  }
}
