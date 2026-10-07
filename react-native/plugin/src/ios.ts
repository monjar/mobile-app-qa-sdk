import type { SnitchResolvedOptions } from './options';

/** Info.plist key of the dictionary the native SDK reads at launch (docs/sdk-spec.md §2.1). */
export const INFO_PLIST_KEY = 'Snitch';

export interface SnitchInfoPlistDict {
  Enabled?: boolean;
  ServerURL: string;
  IngestKey: string;
  EnabledReleaseTypes?: string[];
  Gesture?: string;
  ScreenshotPrompt?: boolean;
  MaskTextInputs?: boolean;
  CaptureMode?: string;
  VideoMaxSeconds?: number;
  ShowTesterNotice?: boolean;
}

/** The `Snitch` dictionary for these options; keys the app didn't set are omitted. */
export function buildInfoPlistDict(options: SnitchResolvedOptions): SnitchInfoPlistDict {
  const dict: SnitchInfoPlistDict = {
    ...(options.enabled !== undefined && { Enabled: options.enabled }),
    ServerURL: options.serverUrl,
    IngestKey: options.ingestKey,
  };
  if (options.enabledReleaseTypes !== undefined) dict.EnabledReleaseTypes = [...options.enabledReleaseTypes];
  if (options.gesture !== undefined) dict.Gesture = options.gesture;
  if (options.screenshotPrompt !== undefined) dict.ScreenshotPrompt = options.screenshotPrompt;
  if (options.maskTextInputs !== undefined) dict.MaskTextInputs = options.maskTextInputs;
  if (options.captureMode !== undefined) dict.CaptureMode = options.captureMode;
  if (options.videoMaxSeconds !== undefined) dict.VideoMaxSeconds = options.videoMaxSeconds;
  if (options.showTesterNotice !== undefined) dict.ShowTesterNotice = options.showTesterNotice;
  return dict;
}

/**
 * Writes the `Snitch` dictionary into an Info.plist object. The dictionary is
 * owned by this plugin and replaced as a whole, so re-running prebuild drops
 * keys that were removed from app.json. Nothing else in the plist is touched.
 */
export function applyIosInfoPlist<T extends Record<string, unknown>>(
  plist: T,
  options: SnitchResolvedOptions,
): T & { [INFO_PLIST_KEY]: SnitchInfoPlistDict } {
  return { ...plist, [INFO_PLIST_KEY]: buildInfoPlistDict(options) };
}
