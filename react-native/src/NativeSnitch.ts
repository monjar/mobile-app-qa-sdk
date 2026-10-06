/**
 * Codegen spec for the `Snitch` TurboModule (RNSnitchSpec).
 *
 * iOS: ios/RNSnitch.mm → SNSnitchBridge (Swift core).
 * Android: android/src/main/java/io/github/monjar/snitch/rn/SnitchModule.kt → io.github.monjar.snitch.Snitch.
 *
 * `TurboModuleRegistry.get` (not `getEnforcing`): when the native module is
 * missing (Expo Go, old architecture, not rebuilt yet) this is `null` and the
 * JS facade in `index.ts` turns every call into a no-op.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /** `options` keys: enabledReleaseTypes, gesture, screenshotPrompt, maskTextInputs, captureMode, videoMaxSeconds, showTesterNotice. */
  // eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
  start(serverUrl: string, ingestKey: string, options: Object): void;
  show(type: string | null): void;
  setUser(userId: string | null, email: string | null, name: string | null): void;
  setMetadata(key: string, value: string | null): void;
  log(message: string, level: string): void;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  getReleaseType(): string;
}

export default TurboModuleRegistry.get<Spec>('Snitch');
