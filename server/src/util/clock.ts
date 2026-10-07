/** Injectable time source so tests can move the clock. Milliseconds since the epoch. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
