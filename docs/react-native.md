# Snitch in bare React Native apps

`react-native-snitch` is a TurboModule plus the native Snitch SDK. The native side starts
itself at launch from Info.plist / AndroidManifest.xml, so the JavaScript API is optional.
Using Expo? Read [expo.md](expo.md) instead: the config plugin writes all of this for you.

Requirements: React Native 0.76+ with the **new architecture** (the JS API is a TurboModule;
the native autostart works either way), iOS 15.1+, Android 7.0+ (API 24). Not available in
Expo Go.

## Install

```sh
npm install react-native-snitch
cd ios && pod install
```

Autolinking adds the pod and the Gradle module. The pod depends only on React Native's own
pods; there is nothing to add to the Podfile.

## Configure

Pick one.

### A. Native configuration (no JavaScript)

iOS, `Info.plist`:

```xml
<key>Snitch</key>
<dict>
  <key>ServerURL</key>
  <string>https://snitch.example.com</string>
  <key>IngestKey</key>
  <string>snitch_pk_0123456789ABCDEFGHJKMNPQRS</string>
  <!-- optional: Enabled, EnabledReleaseTypes (array), Gesture, ScreenshotPrompt,
       MaskTextInputs, CaptureMode, VideoMaxSeconds, ShowTesterNotice, CaptureConsole,
       CaptureNetwork, TrackScreens, CrashPrompt, CheckInWhenInactive -->
</dict>
```

Android, `android/app/src/main/AndroidManifest.xml`, inside `<application>`:

```xml
<meta-data android:name="io.github.monjar.snitch.SERVER_URL" android:value="https://snitch.example.com" />
<meta-data android:name="io.github.monjar.snitch.INGEST_KEY" android:value="snitch_pk_0123456789ABCDEFGHJKMNPQRS" />
<!-- optional: ENABLED, ENABLED_RELEASE_TYPES (comma-separated), GESTURE, SCREENSHOT_PROMPT,
     MASK_TEXT_INPUTS, CAPTURE_MODE, VIDEO_MAX_SECONDS, SHOW_TESTER_NOTICE, RELEASE_TYPE,
     CAPTURE_CONSOLE, CAPTURE_NETWORK, TRACK_SCREENS, CRASH_PROMPT, CHECKIN_WHEN_INACTIVE -->
```

Every option, its values and defaults are listed in [expo.md](expo.md#options) (same meaning;
Info.plist uses PascalCase keys, the manifest `UPPER_SNAKE_CASE`). Without `ServerURL` /
`SERVER_URL` the SDK stays inert.

### B. Start from JavaScript

Call it once, as early as possible, e.g. in `index.js` before `AppRegistry.registerComponent`:

```js
import { Snitch } from 'react-native-snitch';

Snitch.start({
  serverUrl: 'https://snitch.example.com',
  ingestKey: 'snitch_pk_0123456789ABCDEFGHJKMNPQRS',
  // optional: enabledReleaseTypes, gesture, screenshotPrompt, maskTextInputs,
  // captureMode, videoMaxSeconds, showTesterNotice, captureConsole, captureNetwork,
  // trackScreens, crashPrompt, checkInWhenInactive
});
```

A second `start` is ignored, and so is a JS `start` after the native autostart. The native
side autostarts only when it finds a configuration (the Info.plist `Snitch` dictionary, the
`SERVER_URL` meta-data); to keep a manifest configuration but start from JavaScript on Android,
remove the init provider:

```xml
<provider android:name="io.github.monjar.snitch.SnitchInitProvider"
          android:authorities="${applicationId}.snitch-init" tools:node="remove" />
```

The package's second provider (`io.github.monjar.snitch.rn.SnitchReactNativeInitProvider`) never
starts Snitch; it only adds Snitch to React Native's HTTP client when `CAPTURE_NETWORK` is true.

## JavaScript API

```ts
import { Snitch, useSnitchScreen, trackNavigationContainer } from 'react-native-snitch';

Snitch.show(type?: string);                           // open the report sheet ("bug", "idea", …)
Snitch.setUser({ id, email, name } | null);           // reporter shown on the ticket
Snitch.setMetadata(key, value | null);                // custom data on every report
Snitch.log(message, level?: 'debug' | 'info' | 'warn' | 'error');
Snitch.setScreen(name: string | null);                // the screen in the timeline; null clears it
Snitch.setEnabled(enabled: boolean);                  // pause / resume at runtime
Snitch.isEnabled(): boolean;                          // started, allowed, not paused
Snitch.releaseType(): 'debug' | 'adhoc' | 'enterprise' | 'testflight' | 'appstore' | 'internal' | 'play' | 'unknown';

useSnitchScreen(name: string | null | undefined);     // hook: setScreen whenever name changes
trackNavigationContainer(ref): () => void;            // React Navigation container; returns a stop function
```

Every call is a no-op (one console warning) when the native module is missing: Expo Go, the
old architecture, or a build made before installing the package. In Jest the module is
missing too, so tests don't need a mock unless they assert on Snitch calls.

## Timeline

Reports carry a timeline of the last minutes (console lines, requests, screens, touches, app
state) that stays on the device until a tester sends a report. What each kind records, what the
network capture covers and the privacy details are in [expo.md](expo.md#timeline); the options
are the same keys as above. React Native specifics:

- **Console:** JavaScript `console.*` lines arrive with their level. On iOS the package adds a
  React Native log function once Snitch is active (and keeps the log threshold at info or lower);
  on Android they are read from logcat (`ReactNativeJS`) when a report is sent.
- **Network** (`CaptureNetwork` / `CAPTURE_NETWORK`, off by default) covers `fetch`,
  `XMLHttpRequest` and `<Image>` downloads on both platforms. It has to be in Info.plist /
  the manifest: React Native creates its HTTP client before JavaScript runs, so
  `Snitch.start({ captureNetwork: true })` alone doesn't reach it. iOS installs an
  `RCTSetCustomNSURLSessionConfigurationProvider` at launch, Android an
  `OkHttpClientProvider.setOkHttpClientFactory`; an app that sets its own replaces Snitch's. Keep
  the capture by putting `SNSnitchBridge.networkProtocolClass` first in your configuration's
  `protocolClasses` (iOS), or adding `SnitchOkHttpInterceptor()`
  (`io.github.monjar.snitch.network`) to the client your factory builds with `addInterceptor`
  (Android).
- **Screens:** Snitch's native naming mostly sees React Native's root view controller and the
  single activity, so name screens from JavaScript: `useSnitchScreen(usePathname())` in an
  expo-router root layout, `trackNavigationContainer(navigationRef)` with React Navigation, or
  `Snitch.setScreen(name)`. Once the app names a screen, native naming stops for the rest of the
  session.

```tsx
const navigationRef = useNavigationContainerRef();
useEffect(() => trackNavigationContainer(navigationRef), [navigationRef]);
return <NavigationContainer ref={navigationRef}>…</NavigationContainer>;
```

## Masking

Editable text inputs (`TextInput`) are masked by default (`MaskTextInputs`). Any other view is
masked when its `testID` starts with `snitch-mask`:

```tsx
<View testID="snitch-mask-balance">…</View>
```

React Native sets `testID` as the iOS accessibility identifier and as a view tag on Android;
Snitch checks both. A `testID` also keeps the view from being flattened away by Fabric.

## System capture on Android

`captureMode` `system` (MediaProjection) needs these entries in your app manifest (the Expo
plugin adds them); without them keep `snapshot`:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<application>
  <service android:name="io.github.monjar.snitch.system.SnitchProjectionService"
           android:exported="false" android:foregroundServiceType="mediaProjection" />
  <activity android:name="io.github.monjar.snitch.system.SystemCaptureActivity"
            android:exported="false" android:excludeFromRecents="true"
            android:configChanges="orientation|screenSize|screenLayout|keyboardHidden"
            android:theme="@android:style/Theme.Translucent.NoTitleBar" />
</application>
```

Builds with these entries need Google Play's foreground service declaration when uploaded to
Play. The screenshot prompt on Android 14+ also needs
`<uses-permission android:name="android.permission.DETECT_SCREEN_CAPTURE" />`.

## Release types

Snitch only runs in the release types listed in `EnabledReleaseTypes` (default: debug, ad-hoc,
enterprise, TestFlight, Android internal builds) and is inert in App Store and Google Play
installs. Detection happens at run time, so one binary is active in TestFlight and silent once
promoted to the App Store. Details in [expo.md](expo.md#release-types).
