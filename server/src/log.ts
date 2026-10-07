/**
 * Structured logger: one JSON object per line on stdout/stderr, so `docker logs`
 * and Fly's log shipping can parse it. Never pass secrets or report contents.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER[(process.env.SNITCH_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;
let silent = process.env.VITEST === 'true' && process.env.SNITCH_LOG_LEVEL === undefined;

export function setLogLevel(level: Level): void {
  threshold = ORDER[level];
  silent = false;
}

function emit(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
  if (silent || ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...data });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (scope: string, msg: string, data?: Record<string, unknown>) => emit('debug', scope, msg, data),
  info: (scope: string, msg: string, data?: Record<string, unknown>) => emit('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: Record<string, unknown>) => emit('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: Record<string, unknown>) => emit('error', scope, msg, data),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
