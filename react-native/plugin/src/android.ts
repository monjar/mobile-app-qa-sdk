import { AndroidConfig } from 'expo/config-plugins';

import type { SnitchResolvedOptions } from './options';

type AndroidManifest = AndroidConfig.Manifest.AndroidManifest;
type ManifestApplication = AndroidConfig.Manifest.ManifestApplication;

const NS = 'io.github.monjar.snitch';

/** `<meta-data android:name=…>` names read by the native SDK (docs/sdk-spec.md §2.1). */
export const META_DATA = {
  enabled: `${NS}.ENABLED`,
  serverUrl: `${NS}.SERVER_URL`,
  ingestKey: `${NS}.INGEST_KEY`,
  enabledReleaseTypes: `${NS}.ENABLED_RELEASE_TYPES`,
  gesture: `${NS}.GESTURE`,
  screenshotPrompt: `${NS}.SCREENSHOT_PROMPT`,
  maskTextInputs: `${NS}.MASK_TEXT_INPUTS`,
  captureMode: `${NS}.CAPTURE_MODE`,
  videoMaxSeconds: `${NS}.VIDEO_MAX_SECONDS`,
  showTesterNotice: `${NS}.SHOW_TESTER_NOTICE`,
  releaseType: `${NS}.RELEASE_TYPE`,
} as const;

/**
 * Components of the system-capture module, declared only when captureMode is "system".
 * Mirrors android/snitch-system-capture/src/main/AndroidManifest.xml.
 */
export const PROJECTION_SERVICE = `${NS}.system.SnitchProjectionService`;
export const CAPTURE_ACTIVITY = `${NS}.system.SystemCaptureActivity`;
export const SYSTEM_CAPTURE_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.POST_NOTIFICATIONS',
] as const;
export const DETECT_SCREEN_CAPTURE_PERMISSION = 'android.permission.DETECT_SCREEN_CAPTURE';

/** The meta-data entries for these options, in spec order; options the app didn't set are absent. */
export function buildMetaData(options: SnitchResolvedOptions): [name: string, value: string][] {
  const entries: [string, string][] = [];
  const put = (name: string, value: string | number | boolean | undefined) => {
    if (value !== undefined) entries.push([name, String(value)]);
  };
  put(META_DATA.enabled, options.enabled);
  put(META_DATA.serverUrl, options.serverUrl);
  put(META_DATA.ingestKey, options.ingestKey);
  put(META_DATA.enabledReleaseTypes, options.enabledReleaseTypes?.join(','));
  put(META_DATA.gesture, options.gesture);
  put(META_DATA.screenshotPrompt, options.screenshotPrompt);
  put(META_DATA.maskTextInputs, options.maskTextInputs);
  put(META_DATA.captureMode, options.captureMode);
  put(META_DATA.videoMaxSeconds, options.videoMaxSeconds);
  put(META_DATA.showTesterNotice, options.showTesterNotice);
  put(META_DATA.releaseType, options.android.releaseType);
  return entries;
}

function removeAllMetaData(app: ManifestApplication, name: string): void {
  if (!app['meta-data']) return;
  app['meta-data'] = app['meta-data'].filter((item) => item.$['android:name'] !== name);
}

function removeComponent(app: ManifestApplication, kind: 'service' | 'activity', name: string): void {
  const list = app[kind];
  if (!list) return;
  const kept = list.filter((item) => item.$['android:name'] !== name);
  if (kept.length > 0) app[kind] = kept as never;
  else delete app[kind];
}

/**
 * Applies the options to an AndroidManifest (xml2js shape, as `withAndroidManifest` provides it).
 * Idempotent: Snitch's meta-data and system-capture components are replaced on every run, so
 * removing an option from app.json removes it here too. Permissions are only ever added
 * (another library may need them); a clean prebuild starts without them.
 */
export function applyAndroidManifest(manifest: AndroidManifest, options: SnitchResolvedOptions): AndroidManifest {
  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

  for (const name of Object.values(META_DATA)) removeAllMetaData(app, name);
  for (const [name, value] of buildMetaData(options)) {
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, name, value);
  }

  removeComponent(app, 'service', PROJECTION_SERVICE);
  removeComponent(app, 'activity', CAPTURE_ACTIVITY);
  if (options.captureMode === 'system') {
    app.service = [
      ...(app.service ?? []),
      {
        $: {
          'android:name': PROJECTION_SERVICE,
          'android:exported': 'false',
          'android:foregroundServiceType': 'mediaProjection',
        },
      },
    ];
    app.activity = [
      ...(app.activity ?? []),
      {
        $: {
          'android:name': CAPTURE_ACTIVITY,
          'android:configChanges': 'orientation|screenSize|screenLayout|keyboardHidden',
          'android:excludeFromRecents': 'true',
          'android:exported': 'false',
          'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
        },
      },
    ];
    AndroidConfig.Permissions.ensurePermissions(manifest, [...SYSTEM_CAPTURE_PERMISSIONS]);
  }

  if (options.screenshotPrompt !== false && options.android.detectScreenshots) {
    AndroidConfig.Permissions.ensurePermissions(manifest, [DETECT_SCREEN_CAPTURE_PERMISSION]);
  }

  return manifest;
}
