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
 * Screens: `useSnitchScreen(usePathname())` (expo-router) or
 * `trackNavigationContainer(navigationRef)` (React Navigation) name the screen
 * in the report timeline; neither router is a dependency.
 *
 * Every call is a no-op (with one console warning) when the native module is
 * missing: Expo Go, the old architecture, or an app not rebuilt after install.
 */
import { useEffect } from 'react';

import NativeSnitch, { type Spec } from './NativeSnitch';

/** How the running build was distributed, as the SDK detects it at runtime. */
export type SnitchReleaseType = 'debug' | 'adhoc' | 'enterprise' | 'testflight' | 'appstore' | 'internal' | 'play' | 'unknown';

/** What opens the report sheet. */
export type SnitchGesture = 'threeFingerHold' | 'shake' | 'both' | 'none' | 'edgeHandle';

/** Which screen edge the edge handle sits on. */
export type SnitchEdgeHandleSide = 'right' | 'left';

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
  /** Edge for gesture "edgeHandle" (iOS). Default "right". */
  edgeHandleSide?: SnitchEdgeHandleSide;
  /** Vertical centre of the edge handle, as a fraction of the screen height (0.1–0.9). Default 0.33. */
  edgeHandlePosition?: number;
  /** Edge handle tint, "#RRGGBB" or "#RRGGBBAA". Default: the system tint. */
  edgeHandleColor?: string;
  /** Console lines in the report timeline (JavaScript console, os_log / logcat). Default true. */
  captureConsole?: boolean;
  /**
   * Request summaries in the report timeline (method, URL without query values, status, timing, sizes;
   * never headers or bodies). Default false. React Native's own fetch / XMLHttpRequest are only covered
   * when it is also set in Info.plist / the manifest (the config plugin's `captureNetwork`): React
   * Native builds its HTTP client before JavaScript runs.
   */
  captureNetwork?: boolean;
  /** Screen changes in the report timeline, inferred natively until the app calls `Snitch.setScreen`. Default true. */
  trackScreens?: boolean;
  /** After an unexpected exit, offer to report it with the crash diagnostic. Default true. */
  crashPrompt?: boolean;
  /** When the release type can't be detected ("unknown"), send one diagnostic check-in per launch. Default false. */
  checkInWhenInactive?: boolean;
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
  'edgeHandleSide',
  'edgeHandlePosition',
  'edgeHandleColor',
  'captureConsole',
  'captureNetwork',
  'trackScreens',
  'crashPrompt',
  'checkInWhenInactive',
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

/** A screen name as the timeline stores it: trimmed; null for nothing (null, undefined, blank). */
function screenName(v: unknown): string | null {
  const name = optionalString(v)?.trim();
  return name ? name : null;
}

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

  /**
   * Names the screen the tester is on: a `screen` event in the report timeline, and the report's
   * screen. Once the app calls this, Snitch stops inferring screen names natively for the rest of
   * the session. null (or a blank name) clears it.
   */
  setScreen(name: string | null | undefined): void {
    call('setScreen', undefined, (n) => n.setScreen(screenName(name)));
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

/**
 * Calls `Snitch.setScreen(name)` whenever `name` changes. Meant for a value that follows
 * navigation, e.g. in an expo-router root layout:
 *
 *   useSnitchScreen(usePathname());
 *
 * null, undefined and blank names are skipped, so a value that isn't known yet changes nothing.
 */
export function useSnitchScreen(name: string | null | undefined): void {
  const screen = screenName(name);
  useEffect(() => {
    if (screen !== null) Snitch.setScreen(screen);
  }, [screen]);
}

/**
 * The parts of a React Navigation container ref that `trackNavigationContainer` uses. Typed
 * structurally, so react-native-snitch doesn't depend on React Navigation.
 */
export interface SnitchNavigationContainer {
  addListener(event: 'state', listener: () => void): (() => void) | void;
  getCurrentRoute(): { name: string } | null | undefined;
  isReady?(): boolean;
}

/**
 * A container ref from `useNavigationContainerRef()` / `createNavigationContainerRef()`, or a
 * `useRef` whose `current` is the container.
 */
export type SnitchNavigationContainerRef = SnitchNavigationContainer | { readonly current: SnitchNavigationContainer | null };

function resolveContainer(ref: SnitchNavigationContainerRef | null | undefined): SnitchNavigationContainer | null {
  if (ref == null) return null;
  if (typeof (ref as SnitchNavigationContainer).addListener === 'function') return ref as SnitchNavigationContainer;
  const current = (ref as { readonly current: SnitchNavigationContainer | null }).current;
  return current != null && typeof current.addListener === 'function' ? current : null;
}

/**
 * Follows a React Navigation container: the focused route's name becomes the screen
 * (`Snitch.setScreen`) after every navigation state change. Returns a function that stops it.
 *
 *   const navigationRef = useNavigationContainerRef();
 *   useEffect(() => trackNavigationContainer(navigationRef), [navigationRef]);
 *   <NavigationContainer ref={navigationRef}>…</NavigationContainer>
 *
 * A ref from `useNavigationContainerRef()` / `createNavigationContainerRef()` can be passed before
 * the container mounts; a plain `useRef` must already point at it.
 */
export function trackNavigationContainer(ref: SnitchNavigationContainerRef): () => void {
  const container = resolveContainer(ref);
  if (!container) {
    console.warn(
      '[react-native-snitch] trackNavigationContainer: no navigation container yet. Pass the ref from ' +
        'useNavigationContainerRef() or createNavigationContainerRef(), or call it once the container has mounted.',
    );
    return () => {};
  }

  let active = true;
  let last: string | null = null;
  const update = () => {
    if (!active) return;
    try {
      // getCurrentRoute() logs an error on a container ref that isn't attached yet.
      if (container.isReady && !container.isReady()) return;
      const name = screenName(container.getCurrentRoute()?.name);
      if (name === null || name === last) return;
      last = name;
      Snitch.setScreen(name);
    } catch (error) {
      console.warn('[react-native-snitch] trackNavigationContainer failed:', error);
    }
  };

  let unsubscribe: (() => void) | void;
  try {
    unsubscribe = container.addListener('state', update);
  } catch (error) {
    console.warn('[react-native-snitch] trackNavigationContainer failed:', error);
  }
  update();

  return () => {
    active = false;
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}

export default Snitch;
