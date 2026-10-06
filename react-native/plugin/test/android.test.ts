import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AndroidConfig } from 'expo/config-plugins';
import { afterAll, describe, expect, it } from 'vitest';

import { applyAndroidManifest, CAPTURE_ACTIVITY, PROJECTION_SERVICE } from '../src/android';
import { validateOptions } from '../src/options';
import { baseManifest, INGEST_KEY, SERVER_URL } from './fixtures';

type Manifest = AndroidConfig.Manifest.AndroidManifest;

const resolve = (input: Record<string, unknown> = {}) => validateOptions({ serverUrl: SERVER_URL, ingestKey: INGEST_KEY, ...input }, {});
const app = (m: Manifest) => AndroidConfig.Manifest.getMainApplicationOrThrow(m);
const metaData = (m: Manifest) => (app(m)['meta-data'] ?? []).map((e) => [e.$['android:name'], e.$['android:value']]);
const snitchMetaData = (m: Manifest) => metaData(m).filter(([name]) => name?.startsWith('io.github.monjar.snitch.'));
const permissions = (m: Manifest) => AndroidConfig.Permissions.getPermissions(m);
const names = (list: { $: Record<string, string | undefined> }[] | undefined) => (list ?? []).map((e) => e.$['android:name']);

const SYSTEM_PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.POST_NOTIFICATIONS',
];

const FULL = {
  enabled: true,
  enabledReleaseTypes: ['debug', 'internal'],
  gesture: 'threeFingerHold',
  screenshotPrompt: true,
  maskTextInputs: false,
  captureMode: 'snapshot',
  videoMaxSeconds: 30,
  showTesterNotice: true,
  android: { releaseType: 'internal' },
};

describe('applyAndroidManifest', () => {
  it('adds SERVER_URL and INGEST_KEY for the minimal options, after the existing meta-data', () => {
    const m = applyAndroidManifest(baseManifest(), resolve());
    expect(metaData(m)).toEqual([
      ['expo.modules.updates.ENABLED', 'false'],
      ['io.github.monjar.snitch.SERVER_URL', SERVER_URL],
      ['io.github.monjar.snitch.INGEST_KEY', INGEST_KEY],
    ]);
  });

  it('writes every option with the spec §2.1 names and Android value formats', () => {
    const m = applyAndroidManifest(baseManifest(), resolve(FULL));
    expect(snitchMetaData(m)).toEqual([
      ['io.github.monjar.snitch.ENABLED', 'true'],
      ['io.github.monjar.snitch.SERVER_URL', SERVER_URL],
      ['io.github.monjar.snitch.INGEST_KEY', INGEST_KEY],
      ['io.github.monjar.snitch.ENABLED_RELEASE_TYPES', 'debug,internal'],
      ['io.github.monjar.snitch.GESTURE', 'threeFingerHold'],
      ['io.github.monjar.snitch.SCREENSHOT_PROMPT', 'true'],
      ['io.github.monjar.snitch.MASK_TEXT_INPUTS', 'false'],
      ['io.github.monjar.snitch.CAPTURE_MODE', 'snapshot'],
      ['io.github.monjar.snitch.VIDEO_MAX_SECONDS', '30'],
      ['io.github.monjar.snitch.SHOW_TESTER_NOTICE', 'true'],
      ['io.github.monjar.snitch.RELEASE_TYPE', 'internal'],
    ]);
  });

  it('is idempotent', () => {
    const once = applyAndroidManifest(baseManifest(), resolve({ ...FULL, captureMode: 'system' }));
    const snapshot = JSON.parse(JSON.stringify(once));
    const twice = applyAndroidManifest(once, resolve({ ...FULL, captureMode: 'system' }));
    expect(twice).toEqual(snapshot);
    expect(names(app(twice).service)).toEqual([PROJECTION_SERVICE]);
    expect(permissions(twice).filter((p) => p === 'android.permission.FOREGROUND_SERVICE')).toHaveLength(1);
  });

  it('replaces stale and duplicate Snitch meta-data from an earlier run', () => {
    const m = baseManifest();
    app(m)['meta-data']!.push(
      { $: { 'android:name': 'io.github.monjar.snitch.SERVER_URL', 'android:value': 'https://old.example.com' } },
      { $: { 'android:name': 'io.github.monjar.snitch.SERVER_URL', 'android:value': 'https://older.example.com' } },
      { $: { 'android:name': 'io.github.monjar.snitch.GESTURE', 'android:value': 'shake' } },
    );
    applyAndroidManifest(m, resolve());
    expect(snitchMetaData(m)).toEqual([
      ['io.github.monjar.snitch.SERVER_URL', SERVER_URL],
      ['io.github.monjar.snitch.INGEST_KEY', INGEST_KEY],
    ]);
  });

  it('leaves the rest of the manifest alone', () => {
    const m = applyAndroidManifest(baseManifest(), resolve(FULL));
    const expected = baseManifest();
    expect(m.manifest['uses-permission']).toEqual(expected.manifest['uses-permission']);
    expect(app(m).activity).toEqual(app(expected).activity);
    expect(app(m).$).toEqual(app(expected).$);
    expect(app(m).service).toBeUndefined();
  });

  describe('captureMode "system"', () => {
    it('declares the projection service, the consent activity and the permissions', () => {
      const m = applyAndroidManifest(baseManifest(), resolve({ captureMode: 'system' }));
      expect(app(m).service).toEqual([
        {
          $: {
            'android:name': 'io.github.monjar.snitch.system.SnitchProjectionService',
            'android:exported': 'false',
            'android:foregroundServiceType': 'mediaProjection',
          },
        },
      ]);
      expect(app(m).activity?.find((a) => a.$['android:name'] === CAPTURE_ACTIVITY)).toEqual({
        $: {
          'android:name': 'io.github.monjar.snitch.system.SystemCaptureActivity',
          'android:configChanges': 'orientation|screenSize|screenLayout|keyboardHidden',
          'android:excludeFromRecents': 'true',
          'android:exported': 'false',
          'android:theme': '@android:style/Theme.Translucent.NoTitleBar',
        },
      });
      expect(permissions(m)).toEqual(expect.arrayContaining(SYSTEM_PERMISSIONS));
    });

    it.each(['snapshot', 'off', undefined])('adds none of it for captureMode %s', (captureMode) => {
      const m = applyAndroidManifest(baseManifest(), resolve(captureMode ? { captureMode } : {}));
      expect(app(m).service).toBeUndefined();
      expect(names(app(m).activity)).toEqual(['.MainActivity']);
      for (const p of SYSTEM_PERMISSIONS) expect(permissions(m)).not.toContain(p);
    });

    it('removes the components again when switching back to snapshot', () => {
      const m = applyAndroidManifest(baseManifest(), resolve({ captureMode: 'system' }));
      applyAndroidManifest(m, resolve({ captureMode: 'snapshot' }));
      expect(app(m).service).toBeUndefined();
      expect(names(app(m).activity)).toEqual(['.MainActivity']);
    });
  });

  describe('DETECT_SCREEN_CAPTURE', () => {
    const detect = 'android.permission.DETECT_SCREEN_CAPTURE';

    it('is added when android.detectScreenshots is true and the prompt is on', () => {
      expect(permissions(applyAndroidManifest(baseManifest(), resolve({ android: { detectScreenshots: true } })))).toContain(detect);
      expect(
        permissions(applyAndroidManifest(baseManifest(), resolve({ screenshotPrompt: true, android: { detectScreenshots: true } }))),
      ).toContain(detect);
    });

    it('is not added otherwise', () => {
      expect(permissions(applyAndroidManifest(baseManifest(), resolve()))).not.toContain(detect);
      expect(
        permissions(applyAndroidManifest(baseManifest(), resolve({ screenshotPrompt: false, android: { detectScreenshots: true } }))),
      ).not.toContain(detect);
    });
  });

  describe('as XML', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snitch-manifest-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('serialises to the <meta-data>, <service> and <activity> elements the native SDK expects', async () => {
      const file = path.join(dir, 'AndroidManifest.xml');
      const m = applyAndroidManifest(baseManifest(), resolve({ captureMode: 'system', videoMaxSeconds: 10 }));
      await AndroidConfig.Manifest.writeAndroidManifestAsync(file, m);
      const xml = readFileSync(file, 'utf8');
      expect(xml).toContain(`<meta-data android:name="io.github.monjar.snitch.SERVER_URL" android:value="${SERVER_URL}"/>`);
      expect(xml).toContain(`<meta-data android:name="io.github.monjar.snitch.INGEST_KEY" android:value="${INGEST_KEY}"/>`);
      expect(xml).toContain('<meta-data android:name="io.github.monjar.snitch.VIDEO_MAX_SECONDS" android:value="10"/>');
      expect(xml).toContain(
        '<service android:name="io.github.monjar.snitch.system.SnitchProjectionService" android:exported="false" android:foregroundServiceType="mediaProjection"/>',
      );
      expect(xml).toContain('<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION"/>');

      const reread = await AndroidConfig.Manifest.readAndroidManifestAsync(file);
      const before = JSON.parse(JSON.stringify(reread));
      expect(applyAndroidManifest(reread, resolve({ captureMode: 'system', videoMaxSeconds: 10 }))).toEqual(before);
    });
  });
});
