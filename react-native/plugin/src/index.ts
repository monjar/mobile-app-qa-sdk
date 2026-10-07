/**
 * Expo config plugin for react-native-snitch.
 *
 *   "plugins": [["react-native-snitch", { "serverUrl": "https://snitch.example.com", "ingestKey": "snitch_pk_…" }]]
 *
 * iOS: writes the `Snitch` dictionary into Info.plist. Android: writes the
 * `io.github.monjar.snitch.*` <meta-data> entries (plus, for captureMode
 * "system", the system-capture service, activity and permissions). The native
 * SDK starts itself from those at launch; no JavaScript call is needed.
 *
 * Touches nothing else: not the Podfile, entitlements, Gradle files or other
 * plugins' output.
 */
import { createRunOncePlugin, WarningAggregator, withAndroidManifest, withInfoPlist, type ConfigPlugin } from 'expo/config-plugins';

import { applyAndroidManifest } from './android';
import { applyIosInfoPlist } from './ios';
import { assertOptionsShape, optionWarnings, validateOptions, type SnitchPluginProps } from './options';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json') as { name: string; version: string };

const withSnitch: ConfigPlugin<SnitchPluginProps | void> = (config, props) => {
  // Shape errors (typos, wrong types, bad URL/key) fail early, whenever the config is read.
  // serverUrl / ingestKey may still come from SNITCH_* env vars, so their absence is
  // only checked when the native projects are generated.
  assertOptionsShape(props);

  config = withInfoPlist(config, (cfg) => {
    const options = validateOptions(props, process.env);
    for (const warning of optionWarnings(options).ios) WarningAggregator.addWarningIOS(pkg.name, warning);
    cfg.modResults = applyIosInfoPlist(cfg.modResults, options);
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    const options = validateOptions(props, process.env);
    for (const warning of optionWarnings(options).android) WarningAggregator.addWarningAndroid(pkg.name, warning);
    cfg.modResults = applyAndroidManifest(cfg.modResults, options);
    return cfg;
  });

  return config;
};

export default createRunOncePlugin(withSnitch, pkg.name, pkg.version);

export { applyAndroidManifest, buildMetaData, META_DATA, PROJECTION_SERVICE, CAPTURE_ACTIVITY } from './android';
export { applyIosInfoPlist, buildInfoPlistDict, INFO_PLIST_KEY } from './ios';
export {
  validateOptions,
  assertOptionsShape,
  normalizeServerUrl,
  SnitchConfigError,
  INGEST_KEY_PATTERN,
  ENV_SERVER_URL,
  ENV_INGEST_KEY,
} from './options';
export type { SnitchPluginProps, SnitchResolvedOptions, ReleaseType, Gesture, CaptureMode } from './options';
