# Snitch in Expo apps

`react-native-snitch` ships a config plugin. Add it, rebuild, and the native SDK starts
itself at launch: no JavaScript call is needed. Testers hold three fingers on the screen
to send a report.

Requirements: Expo SDK 52 or later (React Native 0.76+, new architecture), iOS 15.1+,
Android 7.0+ (API 24). **Not available in Expo Go**: use a development build
(`npx expo run:ios`, `eas build --profile development`) or any release build. In Expo Go
the JavaScript API does nothing and logs one warning.

## Install

```sh
npx expo install react-native-snitch
```

```json
{
  "expo": {
    "plugins": [
      [
        "react-native-snitch",
        {
          "serverUrl": "https://snitch.example.com",
          "ingestKey": "snitch_pk_0123456789ABCDEFGHJKMNPQRS"
        }
      ]
    ]
  }
}
```

Then regenerate the native projects and rebuild: `npx expo prebuild --clean`, then
`npx expo run:ios` / `run:android`, or an EAS build. Changing plugin options always
needs a rebuild, because they end up in Info.plist and AndroidManifest.xml.

## Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `serverUrl` | string | `SNITCH_SERVER_URL` env | **Required.** Base URL of your Snitch server, `http(s)://host[:port][/path]`. Trailing slashes are dropped. |
| `ingestKey` | string | `SNITCH_INGEST_KEY` env | **Required.** The project's ingest key, `snitch_pk_` + 26 characters (dashboard → project → ingest keys). It is public and write-only. |
| `enabled` | boolean | `true` | Master switch. `false` keeps the SDK fully inert. |
| `enabledReleaseTypes` | string[] | `["debug", "adhoc", "enterprise", "testflight", "internal"]` | Builds Snitch runs in, from `debug`, `adhoc`, `enterprise`, `testflight`, `appstore`, `internal`, `play`. See [release types](#release-types). |
| `gesture` | string | `"threeFingerHold"` | `threeFingerHold`, `shake`, `both`, `none` (open it from code with `Snitch.show()`) or `edgeHandle`: a faded tab on the screen edge that testers pull (iOS only for now; Android keeps `threeFingerHold`). |
| `edgeHandleSide` | string | `"right"` | Edge for `edgeHandle`: `right` or `left`. |
| `edgeHandlePosition` | number | `0.33` | Vertical centre of the handle as a fraction of the screen height, 0.1–0.9. |
| `edgeHandleColor` | string | system tint | Handle tint, `"#RRGGBB"` or `"#RRGGBBAA"`; match your app's accent. |
| `screenshotPrompt` | boolean | `true` | After a system screenshot, offer "Report this screen?". On Android it also needs `android.detectScreenshots` (Android 14+). |
| `maskTextInputs` | boolean | `true` | Black out editable text inputs in screenshots and video. |
| `captureMode` | string | `"snapshot"` | `snapshot` (the SDK draws the app's windows a few times a second, no prompt), `system` (ReplayKit / MediaProjection, OS consent prompt each session) or `off` (screenshots only). |
| `videoMaxSeconds` | integer | `30` | Longest clip a tester can attach, 1–30. |
| `showTesterNotice` | boolean | `true` | One-time card telling testers about the gesture and the on-device recording. |
| `captureConsole` | boolean | `true` | Console lines in the report [timeline](#timeline): the JavaScript console, plus os_log (iOS) / logcat (Android). |
| `captureNetwork` | boolean | `false` | Request summaries in the timeline: method, URL with query values blanked, status, timing, sizes. Never headers or bodies. See [what it covers](#network-requests). |
| `trackScreens` | boolean | `true` | Screen changes in the timeline, named natively until the app names them (see [screens](#screens)). |
| `crashPrompt` | boolean | `true` | On the next launch after the app closed unexpectedly, offer testers to report it with the crash diagnostic attached (needs a Snitch 0.3 server). |
| `checkInWhenInactive` | boolean | `false` | When the build's release type can't be detected (`unknown`), send one check-in per launch so it shows on the Devices page. The only request an inert SDK can make. |
| `android.releaseType` | string | detected | Force the Android release type (any value above, or `unknown`), e.g. per build profile. |
| `android.detectScreenshots` | boolean | `false` | Adds `DETECT_SCREEN_CAPTURE` so `screenshotPrompt` works on Android 14+. Ignored when `screenshotPrompt` is `false`. |

Options are validated when the config is read: unknown keys, wrong types, a malformed URL or
key and out-of-range values fail with a message naming the option. Options you leave out are
not written at all, so the SDK's defaults apply.

### Environment variables

`serverUrl` and `ingestKey` fall back to `SNITCH_SERVER_URL` and `SNITCH_INGEST_KEY` when the
options leave them out (an option always wins). They are read at **prebuild** time, so
`expo start` works without them; set them where prebuild runs, e.g. per EAS build profile:

```jsonc
// eas.json
{ "build": { "preview": { "env": { "SNITCH_SERVER_URL": "https://snitch.example.com", "SNITCH_INGEST_KEY": "snitch_pk_…" } } } }
```

## What the plugin changes

- **iOS:** a `Snitch` dictionary in Info.plist (`ServerURL`, `IngestKey`, and `Enabled`,
  `EnabledReleaseTypes`, `Gesture`, `ScreenshotPrompt`, `MaskTextInputs`, `CaptureMode`,
  `VideoMaxSeconds`, `ShowTesterNotice`, `EdgeHandleSide`, `EdgeHandlePosition`, `EdgeHandleColor`,
  `CaptureConsole`, `CaptureNetwork`, `TrackScreens`, `CrashPrompt`, `CheckInWhenInactive` when set).
  The dictionary belongs to the plugin and is rewritten on every prebuild.
- **Android:** `<meta-data android:name="io.github.monjar.snitch.*">` entries on `<application>`
  (`SERVER_URL`, `INGEST_KEY`, … `RELEASE_TYPE`, `CAPTURE_CONSOLE`, `CAPTURE_NETWORK`,
  `TRACK_SCREENS`, `CRASH_PROMPT`, `CHECKIN_WHEN_INACTIVE`), replaced on every prebuild.
- Nothing else: not the Podfile, entitlements, Gradle files or other plugins' output. The pod and
  the Gradle module come from autolinking; the library manifest adds `INTERNET`,
  `ACCESS_NETWORK_STATE`, a small init provider that starts the SDK, and one that adds Snitch to
  React Native's HTTP client when `captureNetwork` is on.

### `captureMode: "system"` on Android

System mode records the screen with MediaProjection, so the plugin also declares a foreground
service (`foregroundServiceType="mediaProjection"`), a translucent consent activity, and the
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION` and `POST_NOTIFICATIONS`
permissions. Those entries are in the binary whether or not Snitch is active, so a build with
them that you upload to Google Play needs Play Console's **foreground service declaration**
(App content → Foreground service permissions, with a short video of the feature). If that's
a problem, use `system` only in build profiles that never reach Play, and `snapshot` elsewhere.
Snapshot mode needs no permissions or declarations. On iOS, `system` needs no configuration.

## Release types

Snitch decides at **run time** whether it may run, by classifying how the build was installed:

| Type | iOS | Android |
|---|---|---|
| `debug` | simulator, or a development-signed build (`expo run:ios`, dev client) | debuggable build |
| `adhoc` | ad-hoc profile with a device list (EAS internal distribution) | — |
| `enterprise` | in-house profile | — |
| `testflight` | store-signed, sandbox receipt | — |
| `appstore` | store-signed, production receipt | — |
| `internal` | — | release build not installed by a store (sideload, Firebase, MDM, EAS internal) |
| `play` | — | installed by Google Play or another store |

A build is uploaded to App Store Connect once and the same binary goes to TestFlight and then
to the App Store, so `enabledReleaseTypes` can't be decided at build time. With the defaults
the SDK is active in TestFlight and inert in the App Store version of that same binary: no UI,
no capture, no network. Add `appstore` only if you really want reports from store users.

On Android, Play testing tracks (internal, closed, open) are installed by Google Play and
classify as `play`, which is off by default. To collect reports from a Play testing track,
build that artifact with `android.releaseType: "internal"` (for example from an `app.config.js`
that reads an environment variable set only in that EAS profile), rather than enabling `play`
for every Play install.

## Timeline

Every report carries a timeline of the last few minutes before it was sent: console lines,
requests, screen changes, touches and foreground/background, lined up with the video in the
dashboard. It lives in memory (only the newest log lines are also kept on the device, for the
`crashPrompt` follow-up) and leaves the device only inside a report a tester sends. Nothing is
recorded while Snitch is inert (store builds) or paused. Each kind can be switched off with its
option, and per project from the server.

### Console

On by default (`captureConsole`). JavaScript `console.log` / `info` / `warn` / `error` lines show
up with their level, `console.debug` as debug. Native logs come along too: os_log / NSLog lines of
the app process on iOS, the app's logcat on Android. On iOS, once Snitch is active, React Native's
log threshold is kept at info or lower so `console.log` lines are not filtered out. Anything the app
logs can end up in a report, so keep secrets out of logs or set `captureConsole: false`.

### Network requests

Off by default (`captureNetwork: true` turns it on). A request is stored as its method, URL, status,
duration, request and response sizes and error text. The URL loses credentials and the fragment,
and every query value becomes `*` (`/search?q=*&page=*`); the path is kept as sent, so think about
identifiers in paths before turning it on. Headers and bodies are never read. Requests to the
Snitch server itself are never recorded.

| | iOS | Android |
|---|---|---|
| `fetch`, `XMLHttpRequest`, axios and other libraries built on them | ✓ | ✓ |
| `<Image>` downloads | ✓ | ✓ |
| `expo/fetch` (streaming) | ✓ (through Expo's `EXFetchCustomExtension`) | ✓ |
| Native code: `URLSession.shared` (iOS), clients from React Native's `OkHttpClientProvider` (Android) | ✓ | ✓ |
| Other native libraries' own sessions or clients | — | — |

React Native sets up its HTTP client at launch, before any JavaScript runs, so Snitch joins it
only through the plugin option (the `CaptureNetwork` Info.plist key / `CAPTURE_NETWORK`
meta-data); `Snitch.start({ captureNetwork: true })` alone doesn't cover React Native's requests.
If your app installs its own `RCTSetCustomNSURLSessionConfigurationProvider` (iOS) or
`OkHttpClientProvider.setOkHttpClientFactory` (Android), it replaces Snitch's: put
`SNSnitchBridge.networkProtocolClass` first in that configuration's `protocolClasses`, or add
`SnitchOkHttpInterceptor()` to the client your factory builds (`addInterceptor`). The same goes
for `EXFetchCustomExtension.setCustomURLSessionConfigurationProvider` on iOS.

Requests pass through Snitch's forwarding `URLProtocol` on iOS, which relays every chunk as it
arrives, so streamed responses (server-sent events over `expo/fetch`) keep streaming. Still, check
your streaming screens on a device once after turning network capture on.

### Screens

On by default (`trackScreens`). Snitch names screens natively (the top view controller on iOS, the
resumed activity on Android), which in a React Native app is mostly one name. Name them from
JavaScript instead; once you do, native naming stops for the rest of the session:

```tsx
// app/_layout.tsx (expo-router)
import { usePathname } from 'expo-router';
import { useSnitchScreen } from 'react-native-snitch';

export default function RootLayout() {
  useSnitchScreen(usePathname());
  // …
}
```

```tsx
// React Navigation
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { trackNavigationContainer } from 'react-native-snitch';

const navigationRef = useNavigationContainerRef();
useEffect(() => trackNavigationContainer(navigationRef), [navigationRef]);
return <NavigationContainer ref={navigationRef}>…</NavigationContainer>;
```

Neither router is a dependency of react-native-snitch. `Snitch.setScreen('Checkout')` names a
screen directly. The newest name is also the report's screen in the dashboard.

## JavaScript API

Optional; everything above works without it.

```ts
import { Snitch, useSnitchScreen, trackNavigationContainer } from 'react-native-snitch';

Snitch.show();                                        // open the report sheet
Snitch.setUser({ id: user.id, email: user.email });
Snitch.setMetadata('plan', 'pro');                    // null removes the key
Snitch.log('checkout started');
Snitch.setScreen('Checkout');                         // null clears it
Snitch.setEnabled(false);                             // pause at runtime
Snitch.isEnabled();
Snitch.releaseType();                                 // 'testflight', 'debug', …

useSnitchScreen(name);                                // hook: setScreen whenever name changes
trackNavigationContainer(navigationRef);              // React Navigation; returns a stop function
```

`Snitch.start({ serverUrl, ingestKey, ...options })` exists for apps that don't use the plugin
(see [react-native.md](react-native.md)); with the plugin it's a no-op.

## Masking

Editable text inputs are masked by default. To hide any other view in screenshots and video,
give it a `testID` that starts with `snitch-mask`:

```tsx
<View testID="snitch-mask-payment-card">…</View>
```

## Troubleshooting

- **"The native module "Snitch" is not available"**: you're in Expo Go, on the old
  architecture, or the app wasn't rebuilt after installing the package.
- **Reports never arrive from an `http://` server**: iOS App Transport Security and Android's
  cleartext policy block plain HTTP in release builds (the plugin warns at prebuild). Use https,
  or add an exception for your server's host.
- **Nothing happens on a three-finger hold**: check `Snitch.releaseType()` against
  `enabledReleaseTypes`, and that VoiceOver / TalkBack is off (the gesture is disabled then).
- **No requests in the timeline**: `captureNetwork` needs a rebuild, the project's timeline settings
  on the server may switch requests off, and some clients are not covered (see
  [network requests](#network-requests)). Requests to the Snitch server itself never appear.
