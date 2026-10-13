# Snitch for Android

Native Android SDK (Kotlin, minSdk 24 — video needs 26 — compileSdk/targetSdk 35).
No dependencies beyond the Kotlin stdlib (OkHttp is only needed if you use the
optional OkHttp interceptor, and then it's your app's own). Behaviour follows
[`sdk-spec.md`](sdk-spec.md).

## Install (JitPack)

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven("https://jitpack.io")
    }
}

// app/build.gradle.kts
dependencies {
    implementation("com.github.monjar.mobile-app-qa-sdk:snitch:<tag>")
    // optional, only for CAPTURE_MODE=system:
    implementation("com.github.monjar.mobile-app-qa-sdk:snitch-system-capture:<tag>")
}
```

`<tag>` is a release tag of this repository (e.g. `v0.1.0`) or a commit hash.

## Setup

### Zero code (manifest)

Add the server and the project's ingest key; the library's `SnitchInitProvider`
starts Snitch before `Application.onCreate`:

```xml
<application …>
    <meta-data android:name="io.github.monjar.snitch.SERVER_URL" android:value="https://snitch.example.com" />
    <meta-data android:name="io.github.monjar.snitch.INGEST_KEY" android:value="snitch_pk_…" />
</application>
```

### One line of code

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Snitch.start(this, "https://snitch.example.com", "snitch_pk_…")
    }
}
```

Values passed in code win over the manifest. To keep the provider from
auto-starting (e.g. because you start from code with a URL from your own
config), remove it:

```xml
<provider android:name="io.github.monjar.snitch.SnitchInitProvider"
    android:authorities="${applicationId}.snitch-init" tools:node="remove" />
```

Starting later than `Application.onCreate` (e.g. after a sign-in screen) is fine: the provider tracks the
resumed activity from process start, and Snitch attaches to it when it starts. If you removed the provider
*and* start after your first activity resumed, call `Snitch.attach(activity)` once with the visible activity.

## Options

Manifest meta-data (prefix `io.github.monjar.snitch.`) or `SnitchOptions` in code:

| Meta-data | `SnitchOptions` | Default |
|---|---|---|
| `ENABLED` | — (don't call `start`) | `true` |
| `ENABLED_RELEASE_TYPES` (comma-separated) | `enabledReleaseTypes` | `debug,adhoc,enterprise,testflight,internal` |
| `GESTURE` (`threeFingerHold`, `shake`, `both`, `none`) | `gesture` | `threeFingerHold` |
| `SCREENSHOT_PROMPT` | `screenshotPrompt` | `true` (Android 14+, see below) |
| `MASK_TEXT_INPUTS` | `maskTextInputs` | `true` |
| `CAPTURE_MODE` (`snapshot`, `system`, `off`) | `captureMode` | `snapshot` |
| `VIDEO_MAX_SECONDS` (1–30) | `videoMaxSeconds` | `30` |
| `SHOW_TESTER_NOTICE` | `showTesterNotice` | `true` |
| `CAPTURE_CONSOLE` | `captureConsole` | `true` — log lines in the [timeline](#report-timeline) |
| `CAPTURE_NETWORK` | `captureNetwork` | **`false`** — HTTP requests in the timeline ([network capture](#network-capture)) |
| `TRACK_SCREENS` | `trackScreens` | `true` — screen changes in the timeline |
| `CRASH_PROMPT` | `crashPrompt` | `true` — [crash follow-up](#crash-follow-up) |
| `CHECKIN_WHEN_INACTIVE` | `checkInWhenInactive` | `false` — see [check-ins](#check-ins-devices-page) |
| `RELEASE_TYPE` | — | detected |

Once the server's remote config has been fetched it wins for everything it
covers (mask, prompt, clip length, enabled…), except that it can only *restrict*
the capture mode: `off` stays off and `snapshot` is never upgraded to `system`.
Likewise the timeline switches and the crash prompt are on only when both the
app and the server's config say so: the server can turn them off, never on.

```kotlin
Snitch.show()                                    // open the sheet (trigger "api")
Snitch.setUser(id = "42", email = "qa@example.com", name = null)
Snitch.setMetadata("tier", "beta")               // null removes
Snitch.log("checkout started")                   // last 200 lines go with the report, and into the timeline
Snitch.setLogProvider { myLogBuffer.dump() }     // called on a background thread
Snitch.setEnabled(false)                         // pause gesture, capture, timeline and prompts
Snitch.setScreen("Checkout")                     // name the screen (timeline + the report's `screen`)
Snitch.recordNetwork("GET", url, 200, 812.0, null, 20311, null)  // a request made without OkHttp
```

The screenshot prompt ("Report this screen?") uses Android 14's screenshot
callback, which needs a permission the library deliberately doesn't declare. Opt in with:

```xml
<uses-permission android:name="android.permission.DETECT_SCREEN_CAPTURE" />
```

## Report timeline

Every report carries a `timeline` attachment: what happened in the app in the
five minutes before the sheet opened, lined up with the video in the dashboard.
It is kept in memory only (one ring per kind: 500 log lines, 100 requests, 50
screens, 300 touches, 50 app events), frozen when the sheet opens, and written
to disk only when the tester taps Send.

- **App events:** launch, foreground, background, memory warnings.
- **Touches:** where fingers went down (as fractions of the screen), while video capture runs.
- **Console** (`CAPTURE_CONSOLE`): `Snitch.log` lines as they happen, and at Send the
  last 500 lines of *this process's* logcat (`logcat --pid`, no permission needed;
  at most 2 s). React Native's JavaScript console (`ReactNativeJS`) shows as `js`;
  Snitch's own lines are left out.
- **Screens** (`TRACK_SCREENS`): each resumed activity, named by its title when it
  set one, else its class name. Call `Snitch.setScreen(name)` to name screens
  yourself (fragments, Compose destinations): from the first call on, Snitch stops
  naming activities. The newest screen is also the report's `screen`.
- **Network** (`CAPTURE_NETWORK`, off by default): see below.

The server's remote config can switch console, network and screens off per
project and release type.

### Network capture

Turn it on with `CAPTURE_NETWORK` (or `SnitchOptions(captureNetwork = true)`), then:

```kotlin
// OkHttp (4.x): add the interceptor as an application interceptor.
val client = OkHttpClient.Builder()
    .addInterceptor(SnitchOkHttpInterceptor())   // io.github.monjar.snitch.network
    .build()

// Any other client: report each finished request yourself.
Snitch.recordNetwork(method = "POST", url = url, status = 201, durationMs = 412.0,
    requestBytes = 512, responseBytes = 2048, error = null)
```

What is recorded: the method, the URL **sanitized** (no credentials, no
fragment, every query value replaced: `https://api.example.com/search?q=*`),
the status, the duration to the end of the response body (or the failure), the
request and response sizes, and the exception text of a failed request. Never
headers, never bodies. Requests to your Snitch server are never recorded.

The interceptor is safe to install unconditionally, also before Snitch starts
and in store builds: until Snitch is active with network capture on it only
checks one flag and passes the request through. Snitch itself doesn't depend on
OkHttp (it's `compileOnly`); the interceptor class is only loaded if you use it.

Covered: OkHttp clients you add the interceptor to (Retrofit, Coil, Ktor's OkHttp
engine… through the client you give them), and whatever you report with
`recordNetwork`. Not covered automatically: `HttpURLConnection`, Cronet, Volley's
default stack, WebView traffic, and clients built without the interceptor.
React Native: `react-native-snitch` adds the interceptor to React Native's own
OkHttp clients when `captureNetwork` is on.

## Screenshot markup

Tapping the screenshot thumbnail in the sheet opens an editor: draw arrows and
boxes (red, 4 dp), or blur an area, then Done. Blur pixelates the image itself
in 16-pixel blocks, so what was under it can't be recovered from the sent file.
Undo and Clear work on the marks; Cancel keeps the original screenshot.

## Crash follow-up

When the app crashed (or stopped responding) last time, Snitch offers to report
it on the next launch: a pill, "The app closed unexpectedly. Report it?", shown
once per launch. Tapping it opens the sheet as a bug report (trigger `crash`)
with the crash attached as `crash` (text) and the log of the session that
crashed as its timeline. Sending it, closing that sheet, or dismissing the pill
(✕) deletes the saved crash; if the pill just times out, it is offered again on
the next launch. Crashes older than 7 days are dropped. There is no video: the
frames lived only in the crashed process's memory.

- **Java/Kotlin crashes:** Snitch chains an uncaught-exception handler in front of
  the existing one (Android's, or another crash reporter's). It writes the thread
  name and stack trace (≤ 256 KB) and then always hands the exception on, so
  other crash reporters keep working and the app still ends as before.
- **Native crashes and ANRs** (Android 11+): read from the system's record of the
  app's exits (`ApplicationExitInfo`) at the next launch, with the first 512 KB of
  the trace.
- **Session log:** while Snitch is active, the timeline's newest 200 log lines are
  saved every 30 s and when the app goes to the background; logcat lines of the
  crashed process still in the buffer are added at the next launch.

Shown only when the server supports it (servers list `trigger-crash` in their
remote config; older servers don't get crash reports). Turn it off with
`CRASH_PROMPT` false, or per project in the server's remote config.

## Check-ins (Devices page)

Every remote-config fetch doubles as a check-in, so the server's Devices page
shows which installs run Snitch, with which build, SDK version and release type:
the query carries an `installId`, the application id, SDK version, wrapper, the
device model, the release-type `signals` (`debuggable=1;installer=none;override=none`)
and `active=1`. The `installId` is a random UUID created on first activation and
kept in Snitch's SharedPreferences; it is not derived from any device
identifier, and a reinstall gets a new one. Reports carry it too.

An SDK that stays off sends nothing — with one opt-in exception: with
`CHECKIN_WHEN_INACTIVE` true, a build whose release type is `unknown` sends one
config fetch per launch with `active=0` (its answer is ignored), so a build that
never activates can still be spotted. Store (`play`) builds never do. On Android
the detection always decides, so a build is `unknown` only when its
`RELEASE_TYPE` override says so.

## Masking

Every `EditText` (React Native's `TextInput` included) is masked in the
screenshot and every video frame unless `MASK_TEXT_INPUTS` is false. Mask anything else:

```kotlin
Snitch.mask(cardNumberView)            // held weakly; Snitch.unmask(view) to undo
Snitch.addMaskPredicate { it.tag == "secret" }   // runs on the main thread during capture: keep it cheap
```

Jetpack Compose text fields are not `EditText`s: mask their `ComposeView` (or a
container) explicitly.

## System capture (opt-in)

Add `snitch-system-capture` and set `CAPTURE_MODE` to `system`. Snitch then asks
for screen-recording consent (MediaProjection) and records the whole display at
up to `video.systemFps`, including SurfaceViews, dialogs and popups. The module
adds a foreground service of type `mediaProjection` and declares
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PROJECTION` and
`POST_NOTIFICATIONS` (never requested; without it the service notification is
just hidden on Android 13+). Frames are dropped while the app is in the
background. If the tester declines, Snitch uses snapshot mode for the rest of
the session.

## Release types

Snitch runs only in the release types listed in `ENABLED_RELEASE_TYPES` and is
silent (no network traffic) otherwise. On Android:

- `debug` — `android:debuggable` builds
- `play` — installed by Google Play or another public store (Galaxy Store, AppGallery, …)
- `internal` — any other release build: sideloaded APK, Firebase App Distribution, MDM

Google Play's internal, closed and open testing tracks install through the Play
Store exactly like production, and the app can't tell them apart, so they all
detect as `play`, which is off by default. If you distribute test builds through
Play, mark them with the override, typically from a build type or flavour:

```kotlin
// app/build.gradle.kts
android {
    defaultConfig { manifestPlaceholders["snitchReleaseType"] = "" }   // every build type needs a value
    buildTypes {
        create("qa") {
            initWith(getByName("release"))
            manifestPlaceholders["snitchReleaseType"] = "internal"
        }
    }
}
```

```xml
<meta-data android:name="io.github.monjar.snitch.RELEASE_TYPE" android:value="${snitchReleaseType}" />
```

An empty or unknown override is ignored.

## Test hooks (debug builds only)

For UI tests, in code (`Snitch.debugOverrides(SnitchDebugOverrides(...))`, any
time) or as meta-data `DEBUG_SERVER_URL`, `DEBUG_INGEST_KEY`, `DEBUG_AUTOREPORT`
(seconds), `DEBUG_CANCEL_AFTER_MS`, `DEBUG_SHOW_ON_LAUNCH`, `DEBUG_CHUNK_BYTES`
(caps the upload chunk size, never below 64 KiB, so tests exercise chunked
uploads with small files). See spec §9 and §11.10.
`Snitch.debugAwaitIdle(timeoutMs)` blocks a test thread until the auto-report
has been uploaded. Ignored unless the release type is `debug`.

## Known limits

- **SurfaceView / video players / maps** render black in snapshot mode (PixelCopy
  copies the window surface only). Use system capture mode if that matters.
- **Dialogs, popups, bottom sheets and other windows** (including React Native
  `Modal`) are not in snapshot frames or the screenshot in v1, and the gesture
  only works on activity windows.
- **Below Android 8.0 (API 26)** there is no video; screenshots fall back to `View.draw`.
- **ColorOS / OxygenOS / some MIUI builds** reserve a three-finger swipe or hold for
  their own screenshot gesture, which can swallow the trigger. Use `GESTURE=both`
  (shake) or let testers take a system screenshot and tap "Report this screen?".
- TalkBack users: the gesture is disabled while touch exploration is on; use
  shake or a button calling `Snitch.show()`.
- The video is composed when the tester taps Send, using the device's H.264
  encoder (software fallback); nothing is written to disk before that.
- **Uploads** resume where they stopped: servers that take chunked uploads get
  large attachments in chunks (1 MiB by default), and a dropped connection only
  costs the chunk in flight.
- **Logcat** in the timeline is this process's buffer at Send time: on a busy app
  the 500 newest lines may cover less than five minutes, and some OEM builds
  restrict logcat for apps.

## Privacy

Nothing leaves the device unless a tester sends a report (the check-in above is
the only other request, and it carries no user data). What a report can contain
beyond the screenshot and video: `Snitch.log` lines and this process's logcat
(only lines your app or its libraries logged — turn off with `CAPTURE_CONSOLE`),
screen names, touch positions, and with `CAPTURE_NETWORK` request methods,
sanitized URLs, statuses, timings and sizes — never headers or bodies, never
query values. The timeline lives in memory until Send. With the crash follow-up
on, the crash text and the session's newest log lines are kept in the app's
no-backup storage until they are sent or dismissed (at most 7 days).

## Building from source

```sh
cd android
./gradlew :snitch:testDebugUnitTest :snitch:assembleRelease
./gradlew -p logic-jvm test
```

The first command needs the Android SDK. The second runs the pure logic against `contract/vectors` on a plain JVM.
