import type { AndroidConfig } from 'expo/config-plugins';

export const SERVER_URL = 'https://snitch.example.com';
export const INGEST_KEY = 'snitch_pk_0123456789ABCDEFGHJKMNPQRS';

/** Shaped like the AndroidManifest.xml of a fresh `expo prebuild` (xml2js form). */
export function baseManifest(): AndroidConfig.Manifest.AndroidManifest {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android', 'xmlns:tools': 'http://schemas.android.com/tools' },
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.VIBRATE' } },
      ],
      queries: [],
      application: [
        {
          $: { 'android:name': '.MainApplication', 'android:label': '@string/app_name' },
          'meta-data': [
            { $: { 'android:name': 'expo.modules.updates.ENABLED', 'android:value': 'false' } },
          ],
          activity: [
            { $: { 'android:name': '.MainActivity', 'android:exported': 'true', 'android:launchMode': 'singleTask' } },
          ],
        },
      ],
    },
  };
}
