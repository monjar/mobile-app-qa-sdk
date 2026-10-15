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
| `gesture` | `Gesture` | `threeFingerHold` | `shake`, `both`, `none`, `edgeHandle` |
| `edgeHandleSide` | `EdgeHandleSide` | `right` | `left`; edge for `edgeHandle` |
| `edgeHandlePosition` | `EdgeHandlePosition` | `0.33` | vertical centre, fraction of the screen height, 0.1–0.9 |
| `edgeHandleColor` | `EdgeHandleColor` | system tint | `"#RRGGBB"` or `"#RRGGBBAA"` |
| `screenshotPrompt` | `ScreenshotPrompt` | `true` | "Report this screen?" after a system screenshot |
| `maskTextInputs` | `MaskTextInputs` | `true` | mask editable text fields in screenshots and video |
| `captureMode` | `CaptureMode` | `snapshot` | `system` (ReplayKit) or `off` |
| `videoMaxSeconds` | `VideoMaxSeconds` | `30` | 1–30 |
| `showTesterNotice` | `ShowTesterNotice` | `true` | one-time "this is a test build" card |
| `captureConsole` | `CaptureConsole` | `true` | log lines in the report timeline |
| `captureNetwork` | `CaptureNetwork` | **`false`** | HTTP requests in the report timeline |
| `trackScreens` | `TrackScreens` | `true` | screen changes in the report timeline |
| `crashPrompt` | `CrashPrompt` | `true` | offer to report an unexpected exit on the next launch |
| `checkInWhenInactive` | `CheckInWhenInactive` | `false` | one diagnostic ping per launch when the release type is `unknown` |
| — | `Enabled` | `true` | master switch |

The server's remote config is applied on top at run time (types, message,
fps, masking…), except that it can only make `captureMode` stricter — it can
turn video off, never upgrade `snapshot` to `system`. Likewise its timeline
switches (console, network, screens) and `crashPrompt` can only turn off what
the build turned on.

Other API: `Snitch.show(type:)`, `setUser(id:email:name:)`,
`setMetadata(_:_:)`, `log(_:level:)`, `setLogProvider(_:)`, `setEnabled(_:)`,
`isEnabled`, `releaseType`, `mask(_:)` / `unmask(_:)`, `setScreen(_:)`,
`captureNetwork(in:)`. All are safe from any thread. `SnitchBridge.didActivateNotification`
(`"SNSnitchDidActivate"`) is posted on the main thread when Snitch activates.

## Report timeline

Reports sent to a server that supports it (0.3+) carry a `timeline`
attachment: what happened in the app during the last 5 minutes, lined up with
the video in the dashboard. It is kept in memory only, recorded only while
Snitch is on, and leaves the device only with a report the tester sends.

- **App events:** launch, foreground, background, memory warning.
- **Touches:** where fingers went down (as a fraction of the screen).
- **Logs** (`captureConsole`): `Snitch.log` lines, plus this process's unified
  log (`os_log`, `Logger`, `NSLog`) read once at Send — the newest 300 of the
  last 5 minutes, within a 2 s budget. Snitch's own lines are left out.
- **Screens** (`trackScreens`): `Snitch.setScreen("Checkout")` names screens
  yourself (the name also becomes the report's `screen`). Until the app calls
  it, Snitch names the top view controller on each touch and foreground: its
  `title`, else `navigationItem.title`, else the class name. Once the app has
  called `setScreen`, inference stops for the rest of the process.
- **Network** (`captureNetwork`, see below).

## Network capture

Opt-in (`CaptureNetwork` / `captureNetwork: true`). Each request records the
method, the URL with credentials and the fragment removed and every query
value replaced by `*` (`https://api.example.com/search?q=*`), the status,
duration, request/response sizes and the error text. Headers and bodies are
never read. Requests to the Snitch server are never recorded. A request still
running when the report opens is kept too, marked "in flight" with the time it
had taken so far.

How: a forwarding `URLProtocol` (no swizzling). It is registered on activation,
which covers `URLSession.shared` (and `NSURLConnection`). For a session you
create yourself, add it to the configuration before creating the session:

```swift
let config = URLSessionConfiguration.default
Snitch.captureNetwork(in: config)
let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
```

The protocol re-issues each request on its own `URLSession` (default
configuration: the shared cookie storage and URL cache) and relays the
response, data as it streams in, redirects (your session delegate still sees
each hop) and authentication challenges (server trust included, so your
session delegate still answers them) back to your task. Requests pass through
untouched whenever Snitch is not active, so it is safe in configurations used
by store builds.

Not covered:
- sessions created without `captureNetwork(in:)`, and libraries with their own
  networking stack (e.g. `expo/fetch`, gRPC, WebSockets, `Network.framework`);
- background `URLSession`s (custom protocols don't run there).

Caveats: per-session settings of a session you add it to (timeouts, `waitsForConnectivity`,
`allowsCellularAccess`, extra HTTP headers, proxy settings) don't carry over to
the forwarded request — per-request settings do. If your app registers its own
`URLProtocol` for `URLSession.shared`, register it after Snitch activates so
it is consulted first (or leave `captureNetwork` off).

## Screenshot markup

Tapping the screenshot thumbnail in the report sheet opens it full screen with
**Arrow**, **Box** and **Blur** tools, Undo, Clear, Cancel and Done. Done draws
the marks into the image (red, 4 pt); Blur pixelates the pixels themselves, so
what was under it can't be recovered from the file. Masks applied at capture
stay applied.

## Crash follow-up

With `crashPrompt` on and a server that supports it, Snitch subscribes to
MetricKit on activation. When iOS delivers a crash diagnostic of an earlier
session (on iOS 15+ usually right after the next launch), it is saved under
`Application Support/Snitch/crash/` (≤ 512 KB). Snitch then shows "The app
closed unexpectedly. Report it?" once per launch; the sheet opens with type
Bug and the screenshot unticked, and Send attaches the diagnostic (`crash`)
and the previous session's log lines as the timeline. There is no video — the
frames died with the process. Sending or dismissing forgets the crash; crashes
older than 7 days are deleted unseen. While Snitch is active the timeline's
log lines are saved every 30 s and on background (≤ 200 lines) so the next
launch has them. MetricKit does not deliver diagnostics on the Simulator.

## Check-in

Every config request carries a random per-install id (`installId`, created on
first activation and kept in UserDefaults; not derived from any device
identifier, new after a reinstall), the bundle id, SDK version, hardware model
and the release-type signals (`sim=…;profile=…;devices=…;receipt=…;at=…`), so
the server's Devices page shows which builds and devices run Snitch and why a
build was classified as it was. Reports carry the same `installId`.

`CheckInWhenInactive` (off by default): when the release type stays `unknown`
(e.g. StoreKit's AppTransaction couldn't be read), send one config request per
launch with `active=0` and ignore the answer — the only request an inert SDK
ever makes, so you can see such builds on the Devices page. App Store builds
never send it.

## Uploads

Reports go up in three steps (create, attachments, complete) and survive app
kills. With a server that supports resumable uploads, attachments larger than
the server's chunk size (64 KB–8 MB, usually 1 MB) go up in chunks read
straight from disk, and an interrupted upload resumes from the last chunk the
server confirmed instead of starting over.

## Masking

Masked in every frame and in the screenshot (grey box): editable `UITextField`,
`UISearchTextField` and `UITextView` (when `maskTextInputs`), any view passed to
`Snitch.mask(view)`, and any view whose `accessibilityIdentifier` starts with
`snitch-mask`. Hidden, transparent and zero-sized views are skipped.

## Release types

Detected at runtime: simulator or development profile → `debug`; ad-hoc profile
with devices → `adhoc`; `ProvisionsAllDevices` → `enterprise`; sandbox receipt
URL → `testflight`; production receipt URL → `appstore`. The receipt URL's
name is what counts, not the file: TestFlight points at `sandboxReceipt` but
usually installs no file there. On iOS 16+ StoreKit's `AppTransaction` decides
when nothing else does; Snitch waits for it however long it takes and retries
a failed read a few times. Anything ambiguous is `unknown`, which is never
enabled; if it stays unknown, Snitch logs a warning.

## System capture mode

`captureMode = system` records with ReplayKit (`RPScreenRecorder.startCapture`):
full frame rate and Metal/video content, but iOS shows a consent prompt. If the
tester declines, Snitch uses snapshot capture for the rest of the session. If
your app already runs its own in-app ReplayKit session, Snitch doesn't start a
second one: it captures in snapshot mode and switches back once ReplayKit is
free. Capture stops in the background and restarts in the foreground.

## Privacy

The package ships a `PrivacyInfo.xcprivacy`: no tracking; collected data
"other diagnostic data", "crash data" and "other user content", not linked to
the user, for app functionality; required-reason APIs UserDefaults (CA92.1) and
file timestamps (C617.1, for outbox ordering). Video frames and the timeline
live in memory only; nothing is sent until the tester taps Send. On disk:
unsent reports in `Application Support/Snitch/outbox` (excluded from backup,
retried with backoff), and with `crashPrompt` the crash follow-up's files in
`Application Support/Snitch/crash` (the last session's log lines and MetricKit
crash diagnostics; deleted once reported or dismissed, or after 7 days).

What the timeline can contain is app-controlled: log lines are whatever the
app (and the system on its behalf) wrote to the unified log — `os_log`
arguments marked private stay `<private>` — so don't log secrets you wouldn't
put in a bug report. Network capture never records headers, bodies or query
values, but paths are kept as sent: avoid tokens in URL paths, or leave
`captureNetwork` off. The `installId` is random and resets on reinstall.

## Known limitations

- Hardware video layers (`AVPlayerLayer`, DRM content) render black in snapshot mode.
- With the `layerRender` renderer, Metal/OpenGL content (maps, games, `MTKView`) may be missing.
- `drawHierarchy` has crashed apps on some iOS releases (notably 26.3.1). Snitch
  keeps a crash-loop sentinel: two launches in a row that ended during capture
  downgrade the renderer for that app build (drawHierarchy → layerRender → video
  off) and report `health=crashloop` to the server, which can turn capture off remotely.
  Sessions killed while a debugger was attached (Xcode's Stop button) don't count.
- Snapshot capture skips the keyboard window and pauses while a scroll view is tracking.
- Debug hooks (`SNITCH_DEBUG_*` environment variables, see the spec §9 and §11.10) only work in `debug` builds.
- Unified-log lines (`captureConsole`) are read when the report is sent; on a very
  busy log the 2 s budget may keep only the older part of the last 5 minutes.
