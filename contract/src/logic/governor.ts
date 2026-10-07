/**
 * Reference implementation of the snapshot-capture governor: how long to wait
 * before the next frame. Twins: Swift CaptureGovernor, Kotlin CaptureGovernor.
 * Vectors: contract/vectors/governor.json.
 *
 * - idle → idleFps; within activeWindowMs of the last touch → activeFps
 * - never more often than the main-thread budget allows: delay ≥ cost / budget
 * - low-power mode halves the idle rate and drops the interaction boost
 * - thermal serious/critical, or an explicit pause, stops capture (null)
 */

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface GovernorConfig {
  idleFps: number;
  activeFps: number;
  budgetPct: number;
  activeWindowMs: number;
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  idleFps: 1,
  activeFps: 4,
  budgetPct: 3,
  activeWindowMs: 1500,
};

export interface GovernorInput {
  now: number;
  lastTouchAt: number | null;
  avgCostMs: number;
  lowPower: boolean;
  thermal: ThermalState;
  paused: boolean;
}

export function nextCaptureDelayMs(config: GovernorConfig, input: GovernorInput): number | null {
  if (input.paused || input.thermal === 'serious' || input.thermal === 'critical') return null;
  const active =
    !input.lowPower && input.lastTouchAt !== null && input.now - input.lastTouchAt <= config.activeWindowMs;
  const fps = active ? config.activeFps : input.lowPower ? config.idleFps / 2 : config.idleFps;
  const base = 1000 / fps;
  const budgetFloor = input.avgCostMs / (config.budgetPct / 100);
  return Math.round(Math.max(base, budgetFloor));
}

/** Exponentially weighted moving average of capture cost (α = 0.2). */
export function updateAverageCost(avg: number | null, sampleMs: number): number {
  return avg === null ? sampleMs : avg * 0.8 + sampleMs * 0.2;
}
