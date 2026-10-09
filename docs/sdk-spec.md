# Snitch SDK specification

This is the behavioural spec the iOS (Swift), Android (Kotlin) and React Native
implementations follow. The wire contract lives in `contract/` (zod schemas,
fixtures) and the pure logic is pinned by the vectors in `contract/vectors/`;
where this document and those disagree, the contract wins.

Version: 0.1.0. Names: product **Snitch**, SwiftPM module `Snitch`, Android
package `io.github.monjar.snitch`, npm `react-native-snitch`.

---

## 1. Goals and non-goals

- A tester holds three fingers on the screen → a minimal sheet opens → they
  pick a type, describe the problem, keep or untick the screenshot, choose how
  many seconds (1–30) of recent screen video to attach, and send.
- Zero-code setup for Expo/React Native (config plugin + native autostart), one
  line for native apps.
- Lightweight: no third-party dependencies in the native cores; no disk writes
  while recording; capture work capped at ~3% of main-thread time.
- Off (and network-silent) in store builds by default.
- Not a crash reporter, not analytics, not session replay. Nothing leaves the
  device unless the tester sends a report.

## 2. Configuration

### 2.1 Static configuration (build time)

| Meaning | iOS Info.plist (`Snitch` dict) | Android `<meta-data android:name=…>` | Type | Default |
|---|---|---|---|---|
| Master switch | `Enabled` | `io.github.monjar.snitch.ENABLED` | bool | true |
| Server base URL | `ServerURL` | `io.github.monjar.snitch.SERVER_URL` | string | — (required) |
| Ingest key | `IngestKey` | `io.github.monjar.snitch.INGEST_KEY` | string | — (required) |
| Release types the SDK runs in | `EnabledReleaseTypes` (array) | `io.github.monjar.snitch.ENABLED_RELEASE_TYPES` (comma-separated) | list | `debug, adhoc, enterprise, testflight, internal` |
| Trigger gesture | `Gesture` | `io.github.monjar.snitch.GESTURE` | `threeFingerHold` \| `shake` \| `both` \| `none` | `threeFingerHold` |
| "Report this?" after a system screenshot | `ScreenshotPrompt` | `io.github.monjar.snitch.SCREENSHOT_PROMPT` | bool | true (Android: only effective on API 34+ with the permission) |
| Mask editable text inputs | `MaskTextInputs` | `io.github.monjar.snitch.MASK_TEXT_INPUTS` | bool | true |
| Video source | `CaptureMode` | `io.github.monjar.snitch.CAPTURE_MODE` | `snapshot` \| `system` \| `off` | `snapshot` |
| Longest clip offered | `VideoMaxSeconds` | `io.github.monjar.snitch.VIDEO_MAX_SECONDS` | int 1–30 | 30 |
| One-time tester notice | `ShowTesterNotice` | `io.github.monjar.snitch.SHOW_TESTER_NOTICE` | bool | true |
| Release type override | — | `io.github.monjar.snitch.RELEASE_TYPE` | release type | unset |

Native apps may pass the same values in code (`Snitch.start(serverURL:ingestKey:options:)`
/ `Snitch.start(context, serverUrl, ingestKey, options)`); code wins over the plist/manifest.

If `ServerURL` or `IngestKey` is missing or malformed the SDK logs one warning and stays inert.

### 2.2 Remote configuration (run time)

`GET {ServerURL}/api/v1/sdk/config?platform=&releaseType=&appVersion=&build=&os=&health=`
with headers `X-Snitch-Key`, `X-Snitch-SDK: ios/0.1.0` (or `android/…`,
`rn-ios/…`, `rn-android/…`), `If-None-Match` when an ETag is cached.
Response: `SdkConfig` (`contract/fixtures/sdk-config.json`).

- Fetched after start (only when the release type is locally enabled), then
  whenever the cached copy is older than `ttlSeconds` on app foreground.
- Cached (JSON + ETag + fetchedAt) in UserDefaults (`snitch.remoteConfig`) /
  SharedPreferences (`snitch`, key `remoteConfig`).
- Until the first fetch succeeds the SDK runs on `DEFAULT_SDK_CONFIG` merged
  with the static options. A 304 refreshes `fetchedAt`. Network errors keep the cache.
- Effective settings = static options, then remote config on top, except that
  remote config can only *restrict* `captureMode` relative to static (static
  `off` stays off; static `snapshot` cannot be upgraded to `system`, because
  system mode needs manifest entries the app may not have).
- `enabled: false` stops the gesture, capture and prompt immediately (no restart needed);
  `true` again starts them.

## 3. Release type

Classifiers are pure functions; vectors in `contract/vectors/release-type.json`.

**iOS signals**
- `isSimulator`: `#if targetEnvironment(simulator)`.
- `profile`: `Bundle.main.path(forResource: "embedded", ofType: "mobileprovision")`.
  The file is CMS-signed; find the `<?xml` … `</plist>` byte range and parse it
  with `PropertyListSerialization`. Read `Entitlements.get-task-allow`,
  `ProvisionsAllDevices`, `ProvisionedDevices.count`.
- `receipt`: `Bundle.main.appStoreReceiptURL?.lastPathComponent`, whether or
  not the file exists: TestFlight installs point at `sandboxReceipt` but
  usually have no file there. (Deprecated API; call it through
  `Bundle.main.value(forKey:)` / `perform` to avoid the deprecation warning,
  or `@available` shims.)
- `appTransactionEnvironment`: only if nothing above decided, on iOS 16+,
  `AppTransaction.shared` in a detached task, with no timeout: a slow answer
  is still used. A failed read (offline at launch) is retried after about 5,
  15 and 45 s. Until it answers the type is `unknown` (inert); when it
  answers, re-evaluate. Don't rely on it for TestFlight: there StoreKit often
  can't create an AppTransaction at all ("Missing account token",
  `SKInternalErrorDomain` 13, then throttled), which is why the receipt URL's
  name decides first. The answer is never cached across launches: the same
  build can later come from the App Store.

**Android signals**: `ApplicationInfo.FLAG_DEBUGGABLE`; installer from
`getInstallSourceInfo(pkg).installingPackageName` (API 30+) or
`getInstallerPackageName` (older); override from meta-data `RELEASE_TYPE`.

If the detected type is not in `EnabledReleaseTypes`, `start()` returns after
logging one info line. Nothing is installed, no network traffic happens.

## 4. Trigger

### 4.1 Three-finger hold (default)

Pure detector `ThreeFingerHoldDetector` — line-for-line twin of
`contract/src/logic/detector.ts`, vectors `contract/vectors/gesture.json`.
Defaults: 3 pointers, 250 ms landing window, 250 ms hold, 10 pt/dp slop,
1000 ms cooldown. Disabled while VoiceOver / TalkBack is on, while the Snitch
sheet is visible, and while remote config says disabled.

Time base: milliseconds from a monotonic clock (`CACurrentMediaTime()*1000`,
`SystemClock.uptimeMillis()`). Touch coordinates in points (iOS) / dp (Android).
Ticks: fed every display frame while ≥1 touch is down (CADisplayLink on iOS,
`Choreographer` on Android) — or simply schedule a one-shot timer for
`armedAt + holdMs` when the third finger lands; either satisfies the vectors.

**iOS observation.** One `WindowTouchRecognizer` (UIGestureRecognizer
subclass) is added to every app `UIWindow` (current and future: observe
`UIWindow.didBecomeVisibleNotification`; skip Snitch's own windows and the
keyboard windows). Configuration:
- `cancelsTouchesInView = true`, `delaysTouchesBegan = false`, `delaysTouchesEnded = false`
- delegate: `shouldRecognizeSimultaneouslyWith` → true; `shouldRequireFailureOf` → false;
  `shouldBeRequiredToFailBy` → false
- override `canBePrevented(by:)` → false, `canPrevent(_:)` → false
- stays `.possible` for the whole touch sequence, feeding every touch (with
  `location(in: window)`) to the detector and to the touch log (§5.4); sets
  `.failed` when all touches end/cancel without a fire.

On fire (in this order, synchronously on the main thread):
1. Freeze the frame ring at `firstTouchDownTime` of this sequence (the clip
   ends just before the gesture started) and take the screenshot (§5.6).
2. `state = .recognized` → UIKit sends `touchesCancelled` to the touched views.
3. For every other recognizer on the touches of this event
   (`event.allTouches.flatMap { $0.gestureRecognizers }`), excluding self:
   `isEnabled = false; isEnabled = true`. This cancels React Native's
   `RCTSurfaceTouchHandler` (its `reset` emits TouchCancel to JS, so Pressable
   long-press timers die), RNGH handlers and scroll-view pans.
4. On the next run-loop turn: light haptic (`UIImpactFeedbackGenerator(.light)`),
   present the sheet with `trigger = gesture`.

No method swizzling anywhere.

**Android observation.** Wrap each Activity window's `Window.Callback`
(`ActivityLifecycleCallbacks.onActivityCreated`, re-checked in `onActivityResumed`
because AppCompat installs its own wrapper; idempotent — don't wrap twice).
`dispatchTouchEvent(ev)` feeds pointer events (converted to dp) to the
detector and the touch log, then forwards to the original callback. On fire:
take the screenshot, send a copy of the current event with `ACTION_CANCEL` to
the original callback, swallow every further event until the last pointer is
up (`detector.isConsumingSequence`), then show the dialog. Never wrap Snitch's own dialog window.

### 4.2 Shake (optional)

iOS: `motionEnded(.motionShake)` can't be observed without subclassing; use
CoreMotion accelerometer at 20 Hz while the app is active: a shake is ≥3
direction reversals with |a| > 2.3 g within 1 s. Android: SensorManager
accelerometer, same rule. Disabled in `debug` builds when `Gesture == both`
(RN's dev menu owns shake there).

### 4.3 Screenshot prompt

iOS: `UIApplication.userDidTakeScreenshotNotification`. Android 14+:
`Activity.registerScreenCaptureCallback` (needs `DETECT_SCREEN_CAPTURE`, which
the library does **not** declare; the app opts in). On a screenshot, show a
pill at the top: "Report this screen?" for 4 s; tapping it opens the sheet with
`trigger = screenshot` and a fresh screenshot (the system one isn't readable).

### 4.4 Programmatic

`Snitch.show(type:)` opens the sheet (trigger `api`). Works whenever the SDK is enabled.

## 5. Capture

### 5.1 Frame ring

`FrameRing` — twin of `contract/src/logic/ring.ts` (vectors `ring.json`).
Frames: `{ t (ms, monotonic), data (JPEG bytes), width, height, checksum }`.
Limits: snapshot mode 6 MB / 30 s; system mode 10 MB / 30 s (`maxAgeMs` =
`videoMaxSeconds * 1000`). Checksum: a cheap hash of the downscaled pixels
(e.g. FNV-1a over every 16th byte of the bitmap) so an unchanged screen costs
no memory. On memory warning (`didReceiveMemoryWarningNotification` /
`onTrimMemory(TRIM_MEMORY_RUNNING_LOW+)`) call `trimHalf()`.
Nothing is written to disk until a report is sent.

### 5.2 Snapshot mode (default)

Governor — twin of `contract/src/logic/governor.ts` (vectors `governor.json`):
idle 1 fps, active 4 fps (iOS) / 8 fps (Android) for 1.5 s after a touch,
delay never below `avgCost / budget` (3%), ×½ idle and no boost in low-power
mode, paused at thermal serious/critical, while backgrounded, while the Snitch
UI is visible, and while remote config disables video.

**iOS.**
- Schedule with `Timer` in `RunLoop.main` **`.default` mode only** (so no
  capture while a scroll view is tracking).
- Each capture, on the main thread: for every visible app window in
  z-order (skip Snitch windows and keyboard windows, `UIRemoteKeyboardWindow` /
  `UITextEffectsWindow`), draw into one reused `CGContext` (BGRA, premultiplied
  first, little-endian) sized to the screen bounds at **1.0 scale** (points),
  long edge capped at 960 px. Renderer:
  - `drawHierarchy`: `window.drawHierarchy(in: window.frame, afterScreenUpdates: false)`
    inside `UIGraphicsPushContext`.
  - `layerRender`: `window.layer.render(in:)` (misses Metal content; fallback).
- Then fill mask rectangles (§5.5) and measure elapsed time → governor cost.
- Then, on a serial background queue: checksum, JPEG-encode (ImageIO,
  quality 0.55), push to the ring.

**Android.**
- `PixelCopy.request(window, dstBitmap, listener, captureHandler)` on API 26+
  (below 26: video off, screenshots via `View.draw`). `dstBitmap` is the
  window size scaled so the long edge ≤ 960 px (two pooled bitmaps; at most one
  request in flight). Cost = time from request to callback measured on the main
  thread side only for the request call. On the capture thread: draw mask
  rects, checksum, `Bitmap.compress(JPEG, 55)`, push.
- Known gaps (documented): SurfaceView content is black; other windows
  (dialogs, popups, RN `Modal`) are not captured in v1.

**Crash-loop sentinel (iOS).** Before each `drawHierarchy` session starts, set
`snitch.captureSession = renderer` in UserDefaults; clear it on
`willResignActive`/`didEnterBackground`. At launch, if it is still set, the
previous foreground session ended abruptly → increment
`snitch.crashLoopCount`. At 2, downgrade the renderer (`drawHierarchy` →
`layerRender` → video off) for this app build, send `health=crashloop` on the
next config fetch, and count it in `stats.crashLoopDowngrades`. A session that
lasts > 60 s in the foreground resets the counter.

### 5.3 System mode (opt-in)

**iOS.** `RPScreenRecorder.shared()`; if `isRecording` is already true (another
in-app ReplayKit session, e.g. the host app's own recorder), don't start —
fall back to snapshot mode and retry when `RPScreenRecorderDelegate` /
`isRecording` says it's free. `startCapture(handler:)`: for `.video` sample
buffers, keep at most `systemFps` (10) per second, downscale the pixel buffer
(vImage or CIContext on the background queue) to long edge ≤ 960 px, apply
mask rects (computed on the main thread at ≤4 Hz, cached), JPEG, push.
If the user declines the consent prompt, fall back to snapshot mode for the rest of the session.
Stop capture on background; restart on foreground.

**Android** (`snitch-system-capture` module). A `SystemCaptureActivity`
(translucent, no UI) requests `MediaProjectionManager.createScreenCaptureIntent()`;
on consent, start `SnitchProjectionService` (foreground, type
`mediaProjection`, low-importance notification channel "Snitch screen
recording"), create a `VirtualDisplay` → `ImageReader` (RGBA_8888, 2 buffers)
at the downscaled size; on each image (≤ `systemFps`), copy into a bitmap,
mask, JPEG, push. Decline → snapshot mode. The core library finds this module
reflectively (`Class.forName("io.github.monjar.snitch.system.SystemCapture")`),
so the core has no compile-time dependency on it.

### 5.4 Touch log

Ring of `{t, id, x, y, phase}` samples (points/dp, window coordinates), at
most 60 Hz per pointer, kept for `maxAgeMs` + 1 s. Fed by the same observers
as the detector. Used only to draw touch trails into the composed video.

### 5.5 Masking

Applied to every frame and to the screenshot (so what the tester previews is what is sent):
- if `maskTextInputs`: every visible, editable `UITextField` / `UITextView`
  (`isEditable`) / `UISearchTextField`, and Android `EditText`. React Native's
  TextInput is one of these on both platforms.
- any view registered with `Snitch.mask(view)` (weak set) or whose
  `accessibilityIdentifier` (iOS) starts with `snitch-mask`; on Android any view
  for which a registered mask predicate returns true (the RN wrapper registers
  one that reads the RN testID).
- Fill: solid `#8E8E93` with a 1 px darker border, in window coordinates
  converted to frame pixels. Skip views that are hidden, alpha < 0.01 or zero-sized.

### 5.6 Screenshot

At trigger time, before any Snitch UI appears: draw the key window stack at the
**native screen scale** with the configured renderer (iOS) / PixelCopy at full
size (Android), apply masks, keep in memory as JPEG quality 0.8. The sheet
shows a thumbnail. Not written to disk until Send.

### 5.7 Composing the clip (at send time)

Input: the frames `ring.select(endT, N*1000)` frozen at trigger time
(`endT` = first finger down of the trigger sequence, or trigger time for
`api`/`screenshot`), and the touch log for the same window. Schedule — twin of
`clipSchedule` (`compose.json`): 10 fps output, each output frame shows the
newest source frame at or before its time.

- **iOS:** `AVAssetWriter` (`.mp4`, `shouldOptimizeForNetworkUse = true`),
  `AVVideoCodecType.h264`, dimensions of the first frame rounded down to even,
  average bit rate 1.2 Mbps, `AVVideoMaxKeyFrameIntervalKey` 10,
  `AVAssetWriterInputPixelBufferAdaptor` with a pixel buffer pool; explicit
  `CMTime(value: k, timescale: 10)` per frame. Decode each source JPEG once
  (CGImageSource), draw it into the pool buffer, draw touch trails, append.
  Run inside `beginBackgroundTask`.
- **Android:** `MediaCodec` `video/avc`, `COLOR_FormatYUV420Flexible`, input via
  `getInputImage()` (convert ARGB → I420/NV12 per the image's plane strides),
  width/height rounded down to multiples of 16, `KEY_FRAME_RATE` 10,
  `KEY_I_FRAME_INTERVAL` 1, bit rate 1.2 Mbps, explicit `presentationTimeUs`;
  `MediaMuxer` MPEG_4 into `cacheDir`. Fall back to the software encoder
  (`OMX.google.h264.encoder` / `c2.android.avc.encoder`) if the hardware
  encoder fails to configure.
- **Touch trails:** for an output frame at time `t`, draw each touch sample in
  `(t-200ms, t]` as a filled circle (radius 14 pt × frame scale, white at
  alpha 0.55 scaled by recency, 1.5 pt dark outline); the newest sample per
  pointer at full alpha.
- If composing fails, send the report without video and set `stats.videoLost = true`.

## 6. UI

Minimal, native, follows light/dark. No custom fonts.

- **Window/host.** iOS: a dedicated `UIWindow` (scene-aware, `windowLevel = .alert + 1`)
  hosting SwiftUI in a `UIHostingController` with a clear background; dismissing
  removes the window. Android: a `Dialog` with a transparent full-screen window, plain Views.
- **Sheet.** Bottom card, 20 pt corner radius, 16 pt padding,
  `.ultraThinMaterial` (iOS) / surface color with 12 dp elevation (Android),
  dimmed backdrop (black 30%); tap backdrop or swipe down to dismiss (asks to
  discard if the text field isn't empty).
  - Header: "Report" title + close button; optional `message` from remote config under it.
  - Type chips: from remote config `reportTypes` (default Bug · Idea · Other); first selected.
  - Multiline text field, placeholder "What happened?", focused on open, 4–8 lines.
  - Row: ☑ "Screenshot" + 44×88 pt thumbnail (tap → full-screen preview).
  - Row: ☑ "Video  last [ 15 ] s" — number field 1…min(VideoMaxSeconds, buffered
    seconds), digits only, stepper buttons −/+; caption "of 28 s recorded".
    Hidden when video is off; disabled with the caption "Nothing recorded yet"
    when the ring is empty.
  - "More" disclosure: email field (remembered in UserDefaults/SharedPreferences),
    "Pause recording" toggle (stops capture until next launch), SDK version text.
  - Primary button "Send" (disabled while the description is empty *and* no attachment is selected).
- **After Send:** the sheet closes at once; a toast at the top shows "Sending…"
  then "Sent · MOCH-42" or "Saved — will send when online" (2.5 s).
- **Tester notice:** first time the SDK is active on this install, 5 s after
  start (and only when the app is idle): a small card at the bottom — "This is a
  test build. Hold three fingers on the screen to report a problem. The last 30
  seconds of screen activity stay on this device and are only sent with a
  report you submit." Button "Got it". Persist `snitch.noticeShown`.
- **Accessibility:** all controls labelled; Dynamic Type / font scale respected.
- Strings: English only in v1, in one Swift/Kotlin table (no resource bundles).

## 7. Reports, outbox and upload

### 7.1 Building the report

`ReportCreate` exactly as `contract/fixtures/report.create.ios.json`:
- `clientReportId`: UUID v4, lowercase.
- `reportedAt`: ISO-8601 UTC with milliseconds.
- `app`: bundle id / applicationId, display name, `CFBundleShortVersionString`
  / `versionName`, `CFBundleVersion` / `versionCode`, release type.
- `device`: as in the fixture; `model` is the hardware identifier
  (`utsname.machine`, `Build.MODEL`); memory from `task_vm_info.phys_footprint`
  / `Debug.getPss`-free `ActivityManager.MemoryInfo`; network from
  `NWPathMonitor` / `ConnectivityManager`.
- `sdk`: `{name: "snitch-ios"|"snitch-android", version, wrapper?, wrapperVersion?}`
  (the RN bridge sets wrapper `react-native` and its version).
- `custom`: from `setMetadata`; `reporter`: from `setUser` + the email field.
- `stats`: capture stats (p50/p95 of the last 100 capture costs, effective fps over the
  last 30 s, ring bytes, buffered seconds, compose ms, frames skipped, uptime, crash-loop downgrades).
- Attachments: `screenshot` (`image/jpeg`), `video` (`video/mp4`, with
  `durationMs`, `width`, `height`), `logs` (`text/plain`, only if the log ring /
  log provider has content; last 200 lines, ≤ 256 KB). `sha256` lowercase hex.

### 7.2 Outbox

iOS: `Application Support/Snitch/outbox/<clientReportId>/` with
`isExcludedFromBackup = true`, file protection `completeUntilFirstUserAuthentication`.
Android: `noBackupFilesDir/snitch/outbox/<clientReportId>/`.

Files: `report.json` (the ReportCreate body), `screenshot.jpg`, `video.mp4`,
`logs.txt`, `state.json` (`{reportId?, ticket?, attempts, nextAttemptAt, uploaded: [names]}`).
A report directory is only eligible for upload once `report.json` exists
(write attachments first, then `report.json` atomically). Caps: 10 reports or
100 MB — when exceeded, delete the oldest.

### 7.3 Upload algorithm (one report at a time, serial queue)

1. If `state.reportId` is absent: `POST /api/v1/reports` with `report.json`.
   201/200 → save `reportId`, `ticket`, and the server's attachment states.
2. For each declared attachment not `stored`: `PUT /api/v1/reports/{reportId}/attachments/{name}`
   with headers `Content-Type`, `Content-Length`, `X-Content-SHA256`, body = file.
   201/200 → mark uploaded.
3. `POST /api/v1/reports/{reportId}/complete` → 200: delete the directory, show
   "Sent · {ticket}" if this report was sent during this app session.
4. Errors (`contract/src/ingest.ts#isRetryable`): 401/403/413/415/422 → delete the
   report and log once; 409 `attachments_missing` → go back to step 2;
   409 `report_completed` → delete; 404 on PUT/complete → clear `reportId` and restart at 1;
   429/5xx/network → `attempts += 1`, `nextAttemptAt = now + min(30 s · 2^(attempts-1), 1 h)`
   (honour `Retry-After`).
5. Run the queue: after a report is enqueued, on app foreground, and when the
   network path becomes satisfied.

All requests carry `X-Snitch-Key`, `X-Snitch-SDK`, `User-Agent: Snitch/<version> (<platform>)`.
HTTP: `URLSession` with an ephemeral configuration (timeout 30 s; 120 s for
uploads) / `HttpURLConnection` (no OkHttp).

## 8. Public API

### 8.1 Swift (`import Snitch`)

```swift
public enum Snitch {
    public static func start()                                     // reads the Snitch Info.plist dict
    public static func start(serverURL: URL, ingestKey: String, options: SnitchOptions = .init())
    public static func show(type: String? = nil)
    public static func setUser(id: String?, email: String?, name: String?)
    public static func setMetadata(_ key: String, _ value: String?)  // nil removes
    public static func log(_ message: String, level: SnitchLogLevel = .info)
    public static func setLogProvider(_ provider: (() -> String?)?)
    public static func setEnabled(_ enabled: Bool)                   // runtime pause by the app
    public static var isEnabled: Bool { get }                       // started, release type allowed, not paused, remote enabled
    public static var releaseType: SnitchReleaseType { get }
    public static func mask(_ view: UIView)
    public static func unmask(_ view: UIView)
}
public struct SnitchOptions { enabledReleaseTypes, gesture, screenshotPrompt, maskTextInputs,
                              captureMode, videoMaxSeconds, showTesterNotice }   // all with defaults from §2.1
```

Objective-C entry points for the React Native bridge and `+load` autostart
(no RN types in the core):

```swift
@objc(SNSnitchBridge) public final class SnitchBridge: NSObject {
    @objc public static func startFromInfoPlist()
    @objc public static func start(serverURL: String, ingestKey: String, options: [String: Any])
    @objc public static func show(_ type: String?)
    @objc public static func setUser(_ id: String?, email: String?, name: String?)
    @objc public static func setMetadata(_ key: String, value: String?)
    @objc public static func log(_ message: String, level: String)
    @objc public static func setEnabled(_ enabled: Bool)
    @objc public static func isEnabled() -> Bool
    @objc public static func releaseType() -> String
    @objc public static func setWrapper(_ name: String, version: String)
}
```
`options` keys mirror §2.1 names in lowerCamelCase (`enabledReleaseTypes`,
`gesture`, `screenshotPrompt`, `maskTextInputs`, `captureMode`,
`videoMaxSeconds`, `showTesterNotice`).

Calling `start` twice is a no-op (log once). All public methods are main-thread safe
and may be called from any thread (hop to main internally).

### 8.2 Kotlin

```kotlin
object Snitch {
    @JvmStatic fun start(context: Context)                                    // from manifest meta-data
    @JvmStatic @JvmOverloads fun start(context: Context, serverUrl: String, ingestKey: String,
                                       options: SnitchOptions = SnitchOptions())
    @JvmStatic @JvmOverloads fun show(type: String? = null)
    @JvmStatic fun setUser(id: String?, email: String?, name: String?)
    @JvmStatic fun setMetadata(key: String, value: String?)
    @JvmStatic @JvmOverloads fun log(message: String, level: SnitchLogLevel = SnitchLogLevel.INFO)
    @JvmStatic fun setLogProvider(provider: (() -> String?)?)
    @JvmStatic fun setEnabled(enabled: Boolean)
    @JvmStatic val isEnabled: Boolean
    @JvmStatic val releaseType: SnitchReleaseType
    @JvmStatic fun mask(view: View);  @JvmStatic fun unmask(view: View)
    @JvmStatic fun addMaskPredicate(predicate: (View) -> Boolean)
    @JvmStatic fun setWrapper(name: String, version: String)
}
```
Autostart: `SnitchInitProvider` (ContentProvider, `authorities="${applicationId}.snitch-init"`,
`exported=false`, `initOrder` low) calls `Snitch.start(context)` only when the
`SERVER_URL` meta-data exists. Apps can remove it with `tools:node="remove"`.

## 9. Debug hooks (only when release type is `debug`)

Read from the process environment (iOS `ProcessInfo.processInfo.environment`,
set in CI via `SIMCTL_CHILD_*`; Android: instrumentation arguments / system
properties `debug.snitch.*`):

| Variable | Effect |
|---|---|
| `SNITCH_DEBUG_SERVER_URL` | overrides `ServerURL` |
| `SNITCH_DEBUG_INGEST_KEY` | overrides `IngestKey` |
| `SNITCH_DEBUG_AUTOREPORT=<s>` | after `s` seconds, file a report without UI: type `bug`, description `autoreport`, screenshot + `min(5, buffered)` s video, trigger `api` |
| `SNITCH_DEBUG_CANCEL_AFTER_MS=<ms>` | on every touch sequence, `ms` after the first touch down run the real fire path (cancellation included) with a 1-finger sequence, then dismiss the sheet immediately — lets UI tests prove cancellation without a 3-finger gesture |
| `SNITCH_DEBUG_SHOW_ON_LAUNCH=1` | opens the sheet 2 s after start |

## 10. Constraints

- **iOS:** iOS 15.1+, Swift 5.9 language mode, `swift-tools-version: 5.9`.
  No `Bundle.module` (the same sources are compiled inside a CocoaPods pod);
  the only resource is `PrivacyInfo.xcprivacy` (UserDefaults CA92.1; no tracking;
  collected data: other diagnostic data, other user content — not linked,
  app functionality). No third-party dependencies. No swizzling.
- **Android:** minSdk 24 (video needs 26), compileSdk 35, targetSdk 35,
  Kotlin sources must compile with Kotlin 1.9.24+ (`languageVersion = 1.9`),
  JVM target 17. No dependencies beyond the Kotlin stdlib (`org.json` from the
  platform is fine outside `logic/`). Library manifest declares only
  `INTERNET`, `ACCESS_NETWORK_STATE` and the init provider.
- **Pure logic** (`detector`, `governor`, `ring`, `clipSchedule`, release-type
  classifiers) has no platform imports so it is unit-testable against the vectors:
  Swift in `ios/Sources/Snitch/Logic/`, Kotlin in `android/snitch/src/main/java/io/github/monjar/snitch/logic/`.
