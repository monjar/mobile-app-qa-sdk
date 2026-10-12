import { describe, expect, it } from 'vitest';
import type { DeviceView } from '@snitch/contract';
import { classifyAndroid, classifyIos, type AndroidSignals, type IosSignals } from '@snitch/contract/logic';
import vectors from '../../../contract/vectors/release-type.json';
import { androidSignals, deviceVector, iosSignals, parseSignals } from './signals';

/** The §3.1 summary an SDK would send for a vector's signals. */
function iosSummary(s: IosSignals): string {
  const p = s.profile;
  const profile = !p ? 'none' : p.getTaskAllow ? 'dev' : p.provisionsAllDevices ? 'enterprise' : p.provisionedDeviceCount > 0 ? 'adhoc' : 'other';
  return `sim=${s.isSimulator ? 1 : 0};profile=${profile};devices=${p?.provisionedDeviceCount ?? 0};receipt=${s.receipt ?? 'none'};at=${s.appTransactionEnvironment ?? 'none'}`;
}

const androidSummary = (s: AndroidSignals) => `debuggable=${s.debuggable ? 1 : 0};installer=${s.installer ?? 'none'};override=${s.override ?? 'none'}`;

describe('signals', () => {
  it('parses key=value pairs leniently', () => {
    expect(parseSignals('sim=0;profile=adhoc;;devices=12')).toEqual([
      ['sim', '0'],
      ['profile', 'adhoc'],
      ['devices', '12'],
    ]);
    expect(parseSignals(null)).toEqual([]);
    expect(parseSignals('flag')).toEqual([['flag', '']]);
  });

  // Every shared vector survives summary → parse unchanged, and still classifies the same.
  for (const c of vectors.ios as { name: string; signals: IosSignals; expect: string }[]) {
    it(`ios round trip: ${c.name}`, () => {
      const parsed = iosSignals(parseSignals(iosSummary(c.signals)));
      expect(parsed).toEqual(c.signals);
      expect(classifyIos(parsed!)).toBe(c.expect);
    });
  }
  for (const c of vectors.android.filter((v) => v.signals.override?.trim() !== '') as { name: string; signals: AndroidSignals; expect: string }[]) {
    it(`android round trip: ${c.name}`, () => {
      const parsed = androidSignals(parseSignals(androidSummary(c.signals)));
      expect(parsed).toEqual(c.signals);
      expect(classifyAndroid(parsed!)).toBe(c.expect);
    });
  }

  it('reads the pending / failed AppTransaction states and an unreadable profile', () => {
    expect(iosSignals(parseSignals('sim=0;profile=unreadable;devices=0;receipt=none;at=failed'))).toEqual({
      isSimulator: false,
      profile: { getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 0 },
      receipt: null,
      appTransactionEnvironment: null,
    });
    expect(iosSignals(parseSignals('sim=0;profile=none;devices=0;receipt=none;at=pending'))?.appTransactionEnvironment).toBeNull();
  });

  it('refuses signals outside the §3.1 vocabulary', () => {
    expect(iosSignals(parseSignals('sim=0;profile=weird;devices=0;receipt=none;at=none'))).toBeNull();
    expect(iosSignals(parseSignals('profile=none;receipt=none;at=none'))).toBeNull();
    expect(androidSignals(parseSignals('debuggable=0'))).toBeNull();
  });
});

describe('device vector', () => {
  const device: DeviceView = {
    installId: '3d8e6c1a-2b4f-4e5d-8a9b-0c1d2e3f4a5b',
    platform: 'ios',
    releaseType: 'adhoc',
    appId: 'com.mochiro.app',
    appVersion: '0.6.0',
    build: '15',
    os: '26.0.1',
    model: 'iPhone16,2',
    sdkVersion: '0.3.0',
    wrapper: null,
    signals: 'sim=0;profile=adhoc;devices=12;receipt=none;at=none',
    active: true,
    health: 'ok',
    configEnabled: true,
    firstSeenAt: 0,
    lastSeenAt: 0,
    checkins: 1,
    reports: 0,
  };

  it('builds a release-type.json case named after the install', () => {
    expect(deviceVector(device)).toEqual({
      platform: 'ios',
      vector: {
        name: 'iPhone16,2 iOS 26.0.1 build 15',
        signals: { isSimulator: false, profile: { getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 12 }, receipt: null, appTransactionEnvironment: null },
        expect: 'adhoc',
      },
    });
  });

  it('builds Android cases and gives up on missing signals', () => {
    const android = { ...device, platform: 'android' as const, releaseType: 'internal' as const, model: 'Pixel 8', os: '15', signals: 'debuggable=0;installer=dev.firebase.appdistribution;override=none' };
    expect(deviceVector(android)?.vector).toEqual({
      name: 'Pixel 8 Android 15 build 15',
      signals: { debuggable: false, installer: 'dev.firebase.appdistribution', override: null },
      expect: 'internal',
    });
    expect(deviceVector({ ...device, signals: null })).toBeNull();
  });
});
