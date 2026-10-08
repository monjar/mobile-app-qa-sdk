# Snitch for Android

Native Android SDK (Kotlin, minSdk 24 — video needs 26 — compileSdk/targetSdk 35).
No dependencies beyond the Kotlin stdlib. Behaviour follows [`sdk-spec.md`](sdk-spec.md).

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
| `RELEASE_TYPE` | — | detected |

Once the server's remote config has been fetched it wins for everything it
covers (mask, prompt, clip length, enabled…), except that it can only *restrict*
the capture mode: `off` stays off and `snapshot` is never upgraded to `system`.

```kotlin
Snitch.show()                                    // open the sheet (trigger "api")
Snitch.setUser(id = "42", email = "qa@example.com", name = null)
Snitch.setMetadata("tier", "beta")               // null removes
Snitch.log("checkout started")                   // last 200 lines go with the report
Snitch.setLogProvider { myLogBuffer.dump() }     // called on a background thread
Snitch.setEnabled(false)                         // pause gesture, capture and prompts
```

The screenshot prompt ("Report this screen?") uses Android 14's screenshot
callback, which needs a permission the library deliberately doesn't declare. Opt in with:

```xml
<uses-permission android:name="android.permission.DETECT_SCREEN_CAPTURE" />
```

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
(seconds), `DEBUG_CANCEL_AFTER_MS`, `DEBUG_SHOW_ON_LAUNCH`. See spec §9.
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

## Building from source

```sh
cd android
./gradlew :snitch:testDebugUnitTest :snitch:assembleRelease
./gradlew -p logic-jvm test
```

The first command needs the Android SDK. The second runs the pure logic against `contract/vectors` on a plain JVM.
