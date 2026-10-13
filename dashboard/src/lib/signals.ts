/**
 * Release-type detection signals as check-ins carry them (`key=value;…`,
 * docs/sdk-spec.md §3.1), and turning one install's signals into a case for
 * contract/vectors/release-type.json, so a misdetected build becomes a test.
 */
import type { DeviceView, ReleaseType } from '@snitch/contract';
import type { AndroidSignals, IosSignals } from '@snitch/contract/logic';
import { osName } from './format';

export function parseSignals(s: string | null | undefined): [string, string][] {
  if (!s) return [];
  return s
    .split(';')
    .filter((p) => p.trim())
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    });
}

/** The shape of one entry in release-type.json's `ios` / `android` lists. */
export interface ReleaseTypeVector<S> {
  name: string;
  signals: S;
  expect: ReleaseType;
}

export type DeviceVector = { platform: 'ios'; vector: ReleaseTypeVector<IosSignals> } | { platform: 'android'; vector: ReleaseTypeVector<AndroidSignals> };

const flag = (v: string | undefined): boolean | null => (v === '1' ? true : v === '0' ? false : null);

/**
 * `profile` is the summary the SDK derived from embedded.mobileprovision: `dev` when
 * get-task-allow, else `enterprise` when ProvisionsAllDevices, else `adhoc` when it
 * lists devices, else `other`. `unreadable` is the profile the SDK falls back to
 * when it can't parse the file (no flags, no devices).
 */
export function iosSignals(pairs: [string, string][]): IosSignals | null {
  const m = new Map(pairs);
  const isSimulator = flag(m.get('sim'));
  const devices = Number(m.get('devices') ?? 0);
  const profileKind = m.get('profile');
  const receipt = m.get('receipt');
  const at = m.get('at');
  if (isSimulator === null || !Number.isInteger(devices) || devices < 0) return null;

  let profile: IosSignals['profile'];
  if (profileKind === 'none') profile = null;
  else if (profileKind === 'dev') profile = { getTaskAllow: true, provisionsAllDevices: false, provisionedDeviceCount: devices };
  else if (profileKind === 'enterprise') profile = { getTaskAllow: false, provisionsAllDevices: true, provisionedDeviceCount: devices };
  else if (profileKind === 'adhoc' || profileKind === 'other') profile = { getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: devices };
  else if (profileKind === 'unreadable') profile = { getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 0 };
  else return null;

  if (receipt !== 'none' && receipt !== 'sandboxReceipt' && receipt !== 'receipt') return null;
  let appTransactionEnvironment: IosSignals['appTransactionEnvironment'];
  if (at === 'sandbox' || at === 'production' || at === 'xcode') appTransactionEnvironment = at;
  else if (at === 'none' || at === 'pending' || at === 'failed') appTransactionEnvironment = null;
  else return null;

  return { isSimulator, profile, receipt: receipt === 'none' ? null : receipt, appTransactionEnvironment };
}

export function androidSignals(pairs: [string, string][]): AndroidSignals | null {
  const m = new Map(pairs);
  const debuggable = flag(m.get('debuggable'));
  const installer = m.get('installer');
  const override = m.get('override');
  if (debuggable === null || !installer || override === undefined) return null;
  return { debuggable, installer: installer === 'none' ? null : installer, override: override === 'none' ? null : override };
}

/** A vector whose `expect` is what the SDK detected; null when the signals aren't in the §3.1 format. */
export function deviceVector(d: DeviceView): DeviceVector | null {
  const pairs = parseSignals(d.signals);
  const name = [d.model ?? 'Unknown device', osName(d.platform), d.os, `build ${d.build ?? '?'}`].filter(Boolean).join(' ');
  if (d.platform === 'ios') {
    const signals = iosSignals(pairs);
    return signals && { platform: 'ios', vector: { name, signals, expect: d.releaseType } };
  }
  const signals = androidSignals(pairs);
  return signals && { platform: 'android', vector: { name, signals, expect: d.releaseType } };
}
