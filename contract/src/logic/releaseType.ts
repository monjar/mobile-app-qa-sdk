/**
 * Reference classifiers for the release type. Twins: Swift ReleaseTypeClassifier,
 * Kotlin ReleaseTypeClassifier. Vectors: contract/vectors/release-type.json.
 *
 * Fails closed: anything ambiguous is `unknown`, which no default enables.
 */
import type { ReleaseType } from '../enums';

export interface IosSignals {
  isSimulator: boolean;
  /** Parsed embedded.mobileprovision, or null when the app has none (store-signed). */
  profile: { getTaskAllow: boolean; provisionsAllDevices: boolean; provisionedDeviceCount: number } | null;
  /** Last path component of appStoreReceiptURL, if a receipt file exists. */
  receipt: 'sandboxReceipt' | 'receipt' | null;
  /** StoreKit 2 AppTransaction.environment, when it could be read. */
  appTransactionEnvironment: 'sandbox' | 'production' | 'xcode' | null;
}

export function classifyIos(s: IosSignals): ReleaseType {
  if (s.isSimulator) return 'debug';
  if (s.profile) {
    if (s.profile.getTaskAllow) return 'debug';
    if (s.profile.provisionsAllDevices) return 'enterprise';
    if (s.profile.provisionedDeviceCount > 0) return 'adhoc';
    return 'unknown';
  }
  if (s.receipt === 'sandboxReceipt') return 'testflight';
  if (s.receipt === 'receipt') return 'appstore';
  switch (s.appTransactionEnvironment) {
    case 'sandbox':
      return 'testflight';
    case 'production':
      return 'appstore';
    case 'xcode':
      return 'debug';
    default:
      return 'unknown';
  }
}

export const ANDROID_STORE_INSTALLERS: readonly string[] = [
  'com.android.vending',
  'com.google.android.feedback',
  'com.amazon.venezia',
  'com.sec.android.app.samsungapps',
  'com.huawei.appmarket',
  'com.xiaomi.market',
  'com.xiaomi.mipicks',
  'com.heytap.market',
  'com.oppo.market',
  'com.vivo.appstore',
];

export interface AndroidSignals {
  debuggable: boolean;
  installer: string | null;
  /** Manifest placeholder `snitchReleaseType`, if the app set one. */
  override: string | null;
}

const RELEASE_TYPE_SET = new Set<string>(['debug', 'adhoc', 'enterprise', 'testflight', 'appstore', 'internal', 'play', 'unknown']);

export function classifyAndroid(s: AndroidSignals): ReleaseType {
  const o = s.override?.trim();
  if (o && RELEASE_TYPE_SET.has(o)) return o as ReleaseType;
  if (s.debuggable) return 'debug';
  if (s.installer && ANDROID_STORE_INSTALLERS.includes(s.installer)) return 'play';
  return 'internal';
}
