/**
 * Options of the react-native-snitch config plugin, their validation, and the
 * SNITCH_SERVER_URL / SNITCH_INGEST_KEY environment fallback.
 *
 * Keys and defaults mirror docs/sdk-spec.md §2.1. Anything the app doesn't set
 * is left out of Info.plist / AndroidManifest.xml so the native defaults apply.
 */

export const RELEASE_TYPES = ['debug', 'adhoc', 'enterprise', 'testflight', 'appstore', 'internal', 'play', 'unknown'] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];

/** `unknown` means "detection could not decide" and is never enabled, so it can't be listed. */
export const ENABLEABLE_RELEASE_TYPES = RELEASE_TYPES.filter((t): t is Exclude<ReleaseType, 'unknown'> => t !== 'unknown');
export type EnableableReleaseType = Exclude<ReleaseType, 'unknown'>;

export const GESTURES = ['threeFingerHold', 'shake', 'both', 'none'] as const;
export type Gesture = (typeof GESTURES)[number];

export const CAPTURE_MODES = ['snapshot', 'system', 'off'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const VIDEO_MAX_SECONDS_RANGE = { min: 1, max: 30 } as const;

/** `snitch_pk_` + 26 Crockford base32 characters (contract/src/ingest.ts). */
export const INGEST_KEY_PATTERN = /^snitch_pk_[0-9A-HJKMNP-TV-Z]{26}$/;

export const ENV_SERVER_URL = 'SNITCH_SERVER_URL';
export const ENV_INGEST_KEY = 'SNITCH_INGEST_KEY';

/** What goes in app.json: `["react-native-snitch", { ...SnitchPluginProps }]`. */
export interface SnitchPluginProps {
  /** Base URL of your Snitch server. Falls back to the SNITCH_SERVER_URL environment variable. */
  serverUrl?: string;
  /** Project ingest key (`snitch_pk_…`). Falls back to the SNITCH_INGEST_KEY environment variable. */
  ingestKey?: string;
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Release types Snitch runs in. Default: debug, adhoc, enterprise, testflight, internal. */
  enabledReleaseTypes?: EnableableReleaseType[];
  /** What opens the report sheet. Default threeFingerHold. */
  gesture?: Gesture;
  /** Offer "Report this screen?" after a system screenshot. Default true. */
  screenshotPrompt?: boolean;
  /** Black out editable text inputs in screenshots and video. Default true. */
  maskTextInputs?: boolean;
  /** Video source. Default snapshot. `system` on Android adds a foreground service and permissions. */
  captureMode?: CaptureMode;
  /** Longest clip a tester can attach, 1–30 seconds. Default 30. */
  videoMaxSeconds?: number;
  /** One-time "this is a test build" notice. Default true. */
  showTesterNotice?: boolean;
  android?: {
    /** Force the release type instead of detecting it (meta-data RELEASE_TYPE). */
    releaseType?: ReleaseType;
    /**
     * Declare DETECT_SCREEN_CAPTURE so the screenshot prompt works on Android 14+.
     * Only applied while `screenshotPrompt` is not false. Default false.
     */
    detectScreenshots?: boolean;
  };
}

/** Validated options with the environment fallback applied. */
export interface SnitchResolvedOptions {
  serverUrl: string;
  ingestKey: string;
  enabled?: boolean;
  enabledReleaseTypes?: EnableableReleaseType[];
  gesture?: Gesture;
  screenshotPrompt?: boolean;
  maskTextInputs?: boolean;
  captureMode?: CaptureMode;
  videoMaxSeconds?: number;
  showTesterNotice?: boolean;
  android: {
    releaseType?: ReleaseType;
    detectScreenshots: boolean;
  };
}

export type Env = Readonly<Record<string, string | undefined>>;

const TOP_LEVEL_KEYS = [
  'serverUrl',
  'ingestKey',
  'enabled',
  'enabledReleaseTypes',
  'gesture',
  'screenshotPrompt',
  'maskTextInputs',
  'captureMode',
  'videoMaxSeconds',
  'showTesterNotice',
  'android',
] as const;
const ANDROID_KEYS = ['releaseType', 'detectScreenshots'] as const;

const PREFIX = '[react-native-snitch]';

export class SnitchConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`${PREFIX} Invalid config plugin options:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'SnitchConfigError';
    this.problems = problems;
  }
}

const quote = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

const oneOf = (values: readonly string[]): string => values.map((v) => `"${v}"`).join(', ');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Levenshtein distance, case-insensitive; small inputs only. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[t.length]!;
}

function suggest(key: string, known: readonly string[]): string {
  const ranked = known.map((k) => ({ k, d: distance(key, k) })).sort((x, y) => x.d - y.d);
  const best = ranked[0];
  return best && best.d <= 2 ? ` Did you mean "${best.k}"?` : ` Known options: ${known.join(', ')}.`;
}

function checkUnknownKeys(obj: Record<string, unknown>, known: readonly string[], path: string, problems: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) problems.push(`unknown option "${path}${key}".${suggest(key, known)}`);
  }
}

function readBoolean(obj: Record<string, unknown>, key: string, path: string, problems: string[]): boolean | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') {
    problems.push(`${path}${key} must be true or false (got ${quote(v)}).`);
    return undefined;
  }
  return v;
}

function readEnum<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  values: readonly T[],
  path: string,
  problems: string[],
): T | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    problems.push(`${path}${key} must be one of ${oneOf(values)} (got ${quote(v)}).`);
    return undefined;
  }
  return v as T;
}

/** Normalises a server base URL: absolute http(s), no credentials/query/fragment, no trailing slash. */
export function normalizeServerUrl(raw: string): { url?: string; problem?: string } {
  const value = raw.trim();
  const example = 'e.g. "https://snitch.example.com"';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { problem: `serverUrl must be an absolute http(s) URL, ${example} (got ${quote(raw)}).` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { problem: `serverUrl must use http or https, ${example} (got ${quote(raw)}).` };
  }
  if (!parsed.hostname) {
    return { problem: `serverUrl has no host (got ${quote(raw)}).` };
  }
  if (parsed.username || parsed.password) {
    return { problem: `serverUrl must not contain credentials (got ${quote(parsed.origin + parsed.pathname)}).` };
  }
  if (parsed.search || parsed.hash) {
    return { problem: `serverUrl must be the server's base URL without a query or fragment (got ${quote(raw)}).` };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return { url: `${parsed.protocol}//${parsed.host}${path}` };
}

/** True for hosts where cleartext http is normal during development (loopback, private ranges, *.local). */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function envValue(env: Env, name: string): string | undefined {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

interface ParseResult {
  problems: string[];
  options: Partial<SnitchResolvedOptions> & { android: SnitchResolvedOptions['android'] };
}

function parse(input: unknown, env: Env, requireConnection: boolean): ParseResult {
  const problems: string[] = [];
  const options: ParseResult['options'] = { android: { detectScreenshots: false } };

  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) {
    problems.push(`options must be an object like { "serverUrl": "…", "ingestKey": "…" } (got ${quote(input)}).`);
    return { problems, options };
  }
  checkUnknownKeys(input, TOP_LEVEL_KEYS, '', problems);

  // serverUrl: option first, then the environment.
  const rawUrl = input.serverUrl;
  if (rawUrl !== undefined && typeof rawUrl !== 'string') {
    problems.push(`serverUrl must be a string (got ${quote(rawUrl)}).`);
  } else {
    const fromEnv = rawUrl === undefined || rawUrl.trim() === '';
    const value = fromEnv ? envValue(env, ENV_SERVER_URL) : rawUrl;
    if (value === undefined) {
      if (requireConnection) {
        problems.push(`serverUrl is required: set it in the plugin options or the ${ENV_SERVER_URL} environment variable.`);
      }
    } else {
      const { url, problem } = normalizeServerUrl(value);
      if (problem) problems.push(fromEnv ? `${problem} (from ${ENV_SERVER_URL})` : problem);
      else options.serverUrl = url;
    }
  }

  // ingestKey: option first, then the environment.
  const rawKey = input.ingestKey;
  if (rawKey !== undefined && typeof rawKey !== 'string') {
    problems.push(`ingestKey must be a string (got ${quote(rawKey)}).`);
  } else {
    const fromEnv = rawKey === undefined || rawKey.trim() === '';
    const value = fromEnv ? envValue(env, ENV_INGEST_KEY) : rawKey;
    if (value === undefined) {
      if (requireConnection) {
        problems.push(`ingestKey is required: set it in the plugin options or the ${ENV_INGEST_KEY} environment variable.`);
      }
    } else if (!INGEST_KEY_PATTERN.test(value)) {
      problems.push(
        `ingestKey must be "snitch_pk_" followed by 26 Crockford base32 characters (0-9 and A-Z without I, L, O, U)` +
          ` — copy it from your Snitch dashboard (got ${quote(value)}${fromEnv ? ` from ${ENV_INGEST_KEY}` : ''}).`,
      );
    } else {
      options.ingestKey = value;
    }
  }

  options.enabled = readBoolean(input, 'enabled', '', problems);

  const types = input.enabledReleaseTypes;
  if (types !== undefined) {
    if (!Array.isArray(types)) {
      problems.push(`enabledReleaseTypes must be an array such as ["debug", "testflight"] (got ${quote(types)}).`);
    } else if (types.length === 0) {
      problems.push('enabledReleaseTypes must not be empty; use "enabled": false to turn Snitch off.');
    } else {
      const bad = types.filter((t) => typeof t !== 'string' || !(ENABLEABLE_RELEASE_TYPES as readonly string[]).includes(t));
      if (bad.length > 0) {
        const unknownHint = bad.includes('unknown') ? ' ("unknown" is never enabled)' : '';
        problems.push(
          `enabledReleaseTypes contains ${bad.map(quote).join(', ')}; allowed: ${oneOf(ENABLEABLE_RELEASE_TYPES)}${unknownHint}.`,
        );
      } else {
        options.enabledReleaseTypes = [...new Set(types as EnableableReleaseType[])];
      }
    }
  }

  options.gesture = readEnum(input, 'gesture', GESTURES, '', problems);
  options.screenshotPrompt = readBoolean(input, 'screenshotPrompt', '', problems);
  options.maskTextInputs = readBoolean(input, 'maskTextInputs', '', problems);
  options.captureMode = readEnum(input, 'captureMode', CAPTURE_MODES, '', problems);

  const seconds = input.videoMaxSeconds;
  if (seconds !== undefined) {
    const { min, max } = VIDEO_MAX_SECONDS_RANGE;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < min || seconds > max) {
      problems.push(`videoMaxSeconds must be a whole number from ${min} to ${max} (got ${quote(seconds)}).`);
    } else {
      options.videoMaxSeconds = seconds;
    }
  }

  options.showTesterNotice = readBoolean(input, 'showTesterNotice', '', problems);

  const android = input.android;
  if (android !== undefined) {
    if (!isPlainObject(android)) {
      problems.push(`android must be an object such as { "releaseType": "internal" } (got ${quote(android)}).`);
    } else {
      checkUnknownKeys(android, ANDROID_KEYS, 'android.', problems);
      options.android.releaseType = readEnum(android, 'releaseType', RELEASE_TYPES, 'android.', problems);
      options.android.detectScreenshots = readBoolean(android, 'detectScreenshots', 'android.', problems) ?? false;
    }
  }

  // Drop keys the app didn't set so they never reach the native config.
  for (const key of Object.keys(options) as (keyof typeof options)[]) {
    if (options[key] === undefined) delete options[key];
  }
  if (options.android.releaseType === undefined) delete options.android.releaseType;

  return { problems, options };
}

/**
 * Validates plugin options and applies the environment fallback.
 * Throws a SnitchConfigError listing every problem.
 */
export function validateOptions(input: unknown, env: Env = process.env): SnitchResolvedOptions {
  const { problems, options } = parse(input, env, true);
  if (problems.length > 0) throw new SnitchConfigError(problems);
  return options as SnitchResolvedOptions;
}

/**
 * The checks that don't depend on the environment, run when the config is
 * read (`expo start`, `expo export`, …). A missing serverUrl / ingestKey is
 * only an error at prebuild time, where the SNITCH_* variables are expected.
 */
export function assertOptionsShape(input: unknown): void {
  const { problems } = parse(input, {}, false);
  if (problems.length > 0) throw new SnitchConfigError(problems);
}

/** Human-readable warnings for options that are valid but likely to misbehave. */
export function optionWarnings(options: SnitchResolvedOptions): { ios: string[]; android: string[] } {
  const ios: string[] = [];
  const android: string[] = [];
  const url = new URL(options.serverUrl);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    ios.push(
      `serverUrl ${options.serverUrl} uses cleartext http; App Transport Security blocks it unless you add an exception for ${url.hostname}. Prefer https.`,
    );
    android.push(
      `serverUrl ${options.serverUrl} uses cleartext http; release builds block it unless cleartext traffic is allowed for ${url.hostname}. Prefer https.`,
    );
  }
  return { ios, android };
}
