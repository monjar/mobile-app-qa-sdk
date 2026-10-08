# Snitch for iOS

Native Swift SDK: testers hold three fingers on the screen, describe the problem
and send it with a screenshot and the last seconds of screen video. iOS 15.1+,
Swift 5.9, no third-party dependencies, no swizzling. Behaviour is specified in
[`sdk-spec.md`](sdk-spec.md).

## Install

Swift Package Manager: add `https://github.com/monjar/mobile-app-qa-sdk` and
link the **Snitch** product to your app target (Xcode → File → Add Package
Dependencies…), or in a `Package.swift`:

```swift
.package(url: "https://github.com/monjar/mobile-app-qa-sdk", from: "0.1.0"),
// …
.product(name: "Snitch", package: "mobile-app-qa-sdk"),
```

React Native apps use `react-native-snitch` instead; it compiles the same sources.

## Start

One line, once, as early as possible (e.g. `application(_:didFinishLaunchingWithOptions:)`):

```swift
import Snitch

Snitch.start(serverURL: URL(string: "https://snitch.example.com")!,
             ingestKey: "snitch_pk_…")
```

Or put the settings in Info.plist and call `Snitch.start()`:

```xml
<key>Snitch</key>
<dict>
    <key>ServerURL</key><string>https://snitch.example.com</string>
    <key>IngestKey</key><string>snitch_pk_…</string>
</dict>
```

Values passed in code win over Info.plist. A missing or malformed URL/key logs
one warning and leaves the SDK inert. In builds whose release type isn't enabled
(App Store by default) `start()` logs one line and does nothing else — no
gesture, no capture, no network.

## Options

| `SnitchOptions` | Info.plist key | Default | |
|---|---|---|---|
| `enabledReleaseTypes` | `EnabledReleaseTypes` (array) | debug, adhoc, enterprise, testflight, internal | where the SDK runs |
| `gesture` | `Gesture` | `threeFingerHold` | `shake`, `both`, `none` |
| `screenshotPrompt` | `ScreenshotPrompt` | `true` | "Report this screen?" after a system screenshot |
| `maskTextInputs` | `MaskTextInputs` | `true` | mask editable text fields in screenshots and video |
| `captureMode` | `CaptureMode` | `snapshot` | `system` (ReplayKit) or `off` |
| `videoMaxSeconds` | `VideoMaxSeconds` | `30` | 1–30 |
| `showTesterNotice` | `ShowTesterNotice` | `true` | one-time "this is a test build" card |
| — | `Enabled` | `true` | master switch |

The server's remote config is applied on top at run time (types, message,
fps, masking…), except that it can only make `captureMode` stricter — it can
turn video off, never upgrade `snapshot` to `system`.

Other API: `Snitch.show(type:)`, `setUser(id:email:name:)`,
`setMetadata(_:_:)`, `log(_:level:)`, `setLogProvider(_:)`, `setEnabled(_:)`,
`isEnabled`, `releaseType`, `mask(_:)` / `unmask(_:)`. All are safe from any thread.

## Masking

Masked in every frame and in the screenshot (grey box): editable `UITextField`,
`UISearchTextField` and `UITextView` (when `maskTextInputs`), any view passed to
`Snitch.mask(view)`, and any view whose `accessibilityIdentifier` starts with
`snitch-mask`. Hidden, transparent and zero-sized views are skipped.

## Release types

Detected at runtime: simulator or development profile → `debug`; ad-hoc profile
with devices → `adhoc`; `ProvisionsAllDevices` → `enterprise`; sandbox receipt →
`testflight`; production receipt → `appstore`. On iOS 16+ StoreKit's
`AppTransaction` decides when nothing else does. That is the usual case on
TestFlight, which normally installs no receipt: Snitch waits for StoreKit's
answer however long it takes and retries a failed read a few times, so it can
switch on a few seconds after launch. Anything ambiguous is `unknown`, which
is never enabled; if it stays unknown, Snitch logs a warning.

## System capture mode

`captureMode = system` records with ReplayKit (`RPScreenRecorder.startCapture`):
full frame rate and Metal/video content, but iOS shows a consent prompt. If the
tester declines, Snitch uses snapshot capture for the rest of the session. If
your app already runs its own in-app ReplayKit session, Snitch doesn't start a
second one: it captures in snapshot mode and switches back once ReplayKit is
free. Capture stops in the background and restarts in the foreground.

## Privacy

The package ships a `PrivacyInfo.xcprivacy`: no tracking; collected data
"other diagnostic data" and "other user content", not linked to the user, for
app functionality; required-reason APIs UserDefaults (CA92.1) and file
timestamps (C617.1, for outbox ordering). Video frames live in memory only;
nothing is written to disk or sent until the tester taps Send. Unsent reports
wait in `Application Support/Snitch/outbox` (excluded from backup) and are
retried with backoff.

## Known limitations

- Hardware video layers (`AVPlayerLayer`, DRM content) render black in snapshot mode.
- With the `layerRender` renderer, Metal/OpenGL content (maps, games, `MTKView`) may be missing.
- `drawHierarchy` has crashed apps on some iOS releases (notably 26.3.1). Snitch
  keeps a crash-loop sentinel: two launches in a row that ended during capture
  downgrade the renderer for that app build (drawHierarchy → layerRender → video
  off) and report `health=crashloop` to the server, which can turn capture off remotely.
  Sessions killed while a debugger was attached (Xcode's Stop button) don't count.
- Snapshot capture skips the keyboard window and pauses while a scroll view is tracking.
- Debug hooks (`SNITCH_DEBUG_*` environment variables, see the spec §9) only work in `debug` builds.
