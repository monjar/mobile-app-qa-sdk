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
| `gesture` | string | `"threeFingerHold"` | `threeFingerHold`, `shake`, `both` or `none` (open it from code with `Snitch.show()`). |
| `screenshotPrompt` | boolean | `true` | After a system screenshot, offer "Report this screen?". On Android it also needs `android.detectScreenshots` (Android 14+). |
| `maskTextInputs` | boolean | `true` | Black out editable text inputs in screenshots and video. |
| `captureMode` | string | `"snapshot"` | `snapshot` (the SDK draws the app's windows a few times a second, no prompt), `system` (ReplayKit / MediaProjection, OS consent prompt each session) or `off` (screenshots only). |
| `videoMaxSeconds` | integer | `30` | Longest clip a tester can attach, 1–30. |
| `showTesterNotice` | boolean | `true` | One-time card telling testers about the gesture and the on-device recording. |
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
  `VideoMaxSeconds`, `ShowTesterNotice` when set). The dictionary belongs to the plugin and is
  rewritten on every prebuild.
- **Android:** `<meta-data android:name="io.github.monjar.snitch.*">` entries on `<application>`
  (`SERVER_URL`, `INGEST_KEY`, … `RELEASE_TYPE`), replaced on every prebuild.
- Nothing else: not the Podfile, entitlements, Gradle files or other plugins' output. The pod and
  the Gradle module come from autolinking; the library manifest adds `INTERNET`,
  `ACCESS_NETWORK_STATE` and a small init provider that starts the SDK.

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

## JavaScript API

Optional; everything above works without it.

```ts
import { Snitch } from 'react-native-snitch';

Snitch.show();                                        // open the report sheet
Snitch.setUser({ id: user.id, email: user.email });
Snitch.setMetadata('plan', 'pro');                    // null removes the key
Snitch.log('checkout started');
Snitch.setEnabled(false);                             // pause at runtime
Snitch.isEnabled();
Snitch.releaseType();                                 // 'testflight', 'debug', …
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
