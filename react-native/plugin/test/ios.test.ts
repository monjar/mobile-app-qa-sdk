import plist from '@expo/plist';
import { describe, expect, it } from 'vitest';

import { applyIosInfoPlist } from '../src/ios';
import { validateOptions } from '../src/options';
import { INGEST_KEY, SERVER_URL } from './fixtures';

const resolve = (input: Record<string, unknown>) => validateOptions({ serverUrl: SERVER_URL, ingestKey: INGEST_KEY, ...input }, {});

describe('applyIosInfoPlist', () => {
  it('writes only ServerURL and IngestKey for the minimal options', () => {
    const out = applyIosInfoPlist({ CFBundleName: 'App' }, resolve({}));
    expect(out).toEqual({
      CFBundleName: 'App',
      Snitch: { ServerURL: SERVER_URL, IngestKey: INGEST_KEY },
    });
  });

  it('writes every option with the spec §2.1 key names and types, in spec order', () => {
    const out = applyIosInfoPlist(
      {},
      resolve({
        enabled: true,
        enabledReleaseTypes: ['debug', 'adhoc', 'testflight'],
        gesture: 'shake',
        screenshotPrompt: false,
        maskTextInputs: true,
        captureMode: 'system',
        videoMaxSeconds: 20,
        showTesterNotice: false,
        android: { releaseType: 'internal', detectScreenshots: true },
      }),
    );
    expect(out.Snitch).toEqual({
      Enabled: true,
      ServerURL: SERVER_URL,
      IngestKey: INGEST_KEY,
      EnabledReleaseTypes: ['debug', 'adhoc', 'testflight'],
      Gesture: 'shake',
      ScreenshotPrompt: false,
      MaskTextInputs: true,
      CaptureMode: 'system',
      VideoMaxSeconds: 20,
      ShowTesterNotice: false,
    });
    expect(Object.keys(out.Snitch as object)).toEqual([
      'Enabled',
      'ServerURL',
      'IngestKey',
      'EnabledReleaseTypes',
      'Gesture',
      'ScreenshotPrompt',
      'MaskTextInputs',
      'CaptureMode',
      'VideoMaxSeconds',
      'ShowTesterNotice',
    ]);
  });

  it('serialises to the plist types the native side reads (bool, integer, array of strings)', () => {
    const xml = plist.build(applyIosInfoPlist({}, resolve({ enabled: false, videoMaxSeconds: 5, enabledReleaseTypes: ['debug'] })));
    expect(xml).toMatch(/<key>Enabled<\/key>\s*<false\/>/);
    expect(xml).toMatch(/<key>VideoMaxSeconds<\/key>\s*<integer>5<\/integer>/);
    expect(xml).toMatch(/<key>EnabledReleaseTypes<\/key>\s*<array>\s*<string>debug<\/string>\s*<\/array>/);
    expect(xml).toMatch(/<key>ServerURL<\/key>\s*<string>https:\/\/snitch\.example\.com<\/string>/);
  });

  it('replaces an existing Snitch dictionary wholesale and touches nothing else', () => {
    const before = {
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      Snitch: { ServerURL: 'https://old.example.com', IngestKey: INGEST_KEY, Gesture: 'shake', Custom: 1 },
    };
    const once = applyIosInfoPlist(before, resolve({}));
    expect(once).toEqual({
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      Snitch: { ServerURL: SERVER_URL, IngestKey: INGEST_KEY },
    });
    expect(applyIosInfoPlist(once, resolve({}))).toEqual(once);
    expect(before.Snitch.ServerURL).toBe('https://old.example.com');
  });
});
