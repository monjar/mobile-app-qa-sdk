/**
 * react-native-snitch — JavaScript API.
 *
 * Optional: with the Expo config plugin (or the Info.plist `Snitch` dict /
 * Android meta-data) the native SDK starts by itself at launch. Use this API
 * to start from code instead, open the report sheet, or attach context.
 *
 * Masking: any view whose `testID` starts with "snitch-mask" is blacked out in
 * screenshots and video (`<View testID="snitch-mask-card">`). Editable text
 * inputs are masked by default.
 *
 * Every call is a no-op (with one console warning) when the native module is
 * missing: Expo Go, the old architecture, or an app not rebuilt after install.
 */
import NativeSnitch, { type Spec } from './NativeSnitch';

/** How the running build was distributed, as the SDK detects it at runtime. */
export type SnitchReleaseType = 'debug' | 'adhoc' | 'enterprise' | 'testflight' | 'appstore' | 'internal' | 'play' | 'unknown';

/** What opens the report sheet. */
export type SnitchGesture = 'threeFingerHold' | 'shake' | 'both' | 'none';

/** Where video frames come from. `system` = ReplayKit / MediaProjection (OS consent prompt). */
export type SnitchCaptureMode = 'snapshot' | 'system' | 'off';

export type SnitchLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Optional settings; anything left out uses the native default (docs/sdk-spec.md §2.1). */
export interface SnitchOptions {
  /** Release types Snitch runs in. Default: debug, adhoc, enterprise, testflight, internal. */
  enabledReleaseTypes?: readonly Exclude<SnitchReleaseType, 'unknown'>[];
  /** Default "threeFingerHold". */
  gesture?: SnitchGesture;
  /** Offer "Report this screen?" after a system screenshot. Default true. */
  screenshotPrompt?: boolean;
  /** Mask editable text inputs. Default true. */
  maskTextInputs?: boolean;
  /** Default "snapshot". "system" on Android needs the manifest entries the config plugin adds. */
  captureMode?: SnitchCaptureMode;
  /** Longest clip offered, 1–30 seconds. Default 30. */
  videoMaxSeconds?: number;
  /** One-time "this is a test build" notice. Default true. */
  showTesterNotice?: boolean;
}

export interface SnitchStartOptions extends SnitchOptions {
  /** Base URL of your Snitch server, e.g. "https://snitch.example.com". */
  serverUrl: string;
  /** Project ingest key, "snitch_pk_…". */
  ingestKey: string;
}

export interface SnitchUser {
  id?: string | null;
  email?: string | null;
  name?: string | null;
}

/** A view whose `testID` starts with this prefix is masked in screenshots and video. */
export const SNITCH_MASK_PREFIX = 'snitch-mask';

const OPTION_KEYS: readonly (keyof SnitchOptions)[] = [
  'enabledReleaseTypes',
  'gesture',
  'screenshotPrompt',
  'maskTextInputs',
  'captureMode',
  'videoMaxSeconds',
  'showTesterNotice',
];

const RELEASE_TYPES: readonly SnitchReleaseType[] = ['debug', 'adhoc', 'enterprise', 'testflight', 'appstore', 'internal', 'play', 'unknown'];

let warnedMissing = false;

function getNative(): Spec | null {
  if (NativeSnitch) return NativeSnitch;
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(
      '[react-native-snitch] The native module "Snitch" is not available, so Snitch calls do nothing. ' +
        'It needs a development or release build with the new architecture (not Expo Go); ' +
        'rebuild the app after installing react-native-snitch.',
    );
  }
  return null;
}

/** Runs a native call; a QA tool must never take the app down, so failures are logged, not thrown. */
function call<T>(name: string, fallback: T, fn: (native: Spec) => T): T {
  const native = getNative();
  if (!native) return fallback;
  try {
    return fn(native);
  } catch (error) {
    console.warn(`[react-native-snitch] Snitch.${name} failed:`, error);
    return fallback;
  }
}

const optionalString = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v));

function nativeOptions(options: SnitchOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of OPTION_KEYS) {
    const value = options[key];
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

export const Snitch = {
  /**
   * Starts Snitch from code. Not needed when the config plugin / Info.plist /
   * manifest already configure it (the native SDK then starts at launch and
   * this call is a no-op). Call once, as early as possible (e.g. in index.js).
   */
  start(options: SnitchStartOptions): void {
    const { serverUrl, ingestKey } = options ?? ({} as SnitchStartOptions);
    if (typeof serverUrl !== 'string' || typeof ingestKey !== 'string') {
      console.warn('[react-native-snitch] Snitch.start needs { serverUrl, ingestKey } strings; ignoring the call.');
      return;
    }
    call('start', undefined, (n) => n.start(serverUrl, ingestKey, nativeOptions(options)));
  },

  /** Opens the report sheet, optionally preselecting a report type (e.g. "bug"). */
  show(type?: string | null): void {
    call('show', undefined, (n) => n.show(optionalString(type)));
  },

  /** Identifies the tester in reports. Pass null to clear. */
  setUser(user: SnitchUser | null): void {
    call('setUser', undefined, (n) =>
      n.setUser(optionalString(user?.id), optionalString(user?.email), optionalString(user?.name)),
    );
  },

  /** Adds a key/value to every report's custom data; null or undefined removes the key. */
  setMetadata(key: string, value: string | number | boolean | null | undefined): void {
    call('setMetadata', undefined, (n) => n.setMetadata(String(key), optionalString(value)));
  },

  /** Appends a line to the log attached to reports. */
  log(message: string, level: SnitchLogLevel = 'info'): void {
    call('log', undefined, (n) => n.log(String(message), level));
  },

  /** Pauses (false) or resumes (true) Snitch at runtime: gesture, capture and prompts. */
  setEnabled(enabled: boolean): void {
    call('setEnabled', undefined, (n) => n.setEnabled(Boolean(enabled)));
  },

  /** True when started, the release type is enabled, not paused, and the server allows it. */
  isEnabled(): boolean {
    return call('isEnabled', false, (n) => n.isEnabled() === true);
  },

  /** The release type detected for this build ("unknown" when the native module is missing). */
  releaseType(): SnitchReleaseType {
    return call('releaseType', 'unknown' as SnitchReleaseType, (n) => {
      const value = n.getReleaseType();
      return (RELEASE_TYPES as readonly string[]).includes(value) ? (value as SnitchReleaseType) : 'unknown';
    });
  },
} as const;

export default Snitch;
