# Architecture

```
 ┌──────────── device ────────────┐          ┌──────────── server (one container) ───────────┐
 │ app                            │          │                                               │
 │  └─ Snitch core (Swift/Kotlin) │  HTTPS   │  /api/v1   intake ── SQLite (tickets, events) │
 │      trigger → sheet → report ─┼─────────▶│                 └── blobs (fs or S3)          │
 │      frame ring (RAM only)     │          │  worker ── GitHub / SMTP / webhooks           │
 │      outbox (disk, until sent) │◀─────────┼─ /api/v1/sdk/config (remote on/off, capture)  │
 └────────────────────────────────┘          │  /api/admin + dashboard (React SPA)           │
                                             └───────────────────────────────────────────────┘
```

## Pieces

| Path | What | Verified by |
|---|---|---|
| `contract/` | Wire schemas (zod), fixtures, reference implementations of the pure logic, shared test vectors | `npm test -w contract` |
| `server/` | Intake, admin API, worker, storage | `npm test -w server`, Docker smoke test |
| `dashboard/` | Admin SPA served by the server | Playwright against the real server |
| `ios/` + `Package.swift` | Swift core (SwiftPM product `Snitch`) | XCTest on the simulator (CI) |
| `android/` | Kotlin core (`snitch`) + optional `snitch-system-capture` | JVM logic tests, emulator tests (CI) |
| `react-native/` | npm `react-native-snitch`: TurboModule + Expo config plugin, embeds both cores | plugin tests, Expo builds (CI) |

The native cores carry line-for-line twins of `contract/src/logic/*` (gesture detector, capture governor,
frame ring, clip schedule, release-type classifiers). All three implementations run against the same JSON vectors.
A behaviour change starts with a vector.

## Reporting flow

1. **Trigger.** The detector watches touches passively, without swizzling: a gesture recognizer per window on iOS,
   a `Window.Callback` wrapper on Android. Three fingers that land within 250 ms and stay still for 250 ms fire it,
   within 400 ms of the first touch, so before the usual 500 ms long-press timers run out. At that moment the SDK:
   - takes the screenshot,
   - freezes the frame ring at the first touch (so the gesture isn't in the clip),
   - cancels the app's in-flight touches (so the app sees `touchesCancelled` / `ACTION_CANCEL`, not a long press),
   - opens the sheet in its own window above the app.
2. **Report.** The tester picks a type, writes a description and chooses attachments. On Send:
   - the clip is composed from the frozen frames into H.264 MP4,
   - everything is written to the outbox,
   - the sheet closes immediately.
3. **Upload** goes through the outbox, one report at a time, and survives restarts:
   1. `POST /reports` (idempotent on a client UUID).
   2. `PUT /reports/:id/attachments/:name` for each attachment. Raw bytes are streamed to disk on the server and
      checked against the declared length, SHA-256 and magic number.
   3. `POST /reports/:id/complete`.

   Network errors and 5xx/429 responses back off from 30 s up to 1 h. 4xx responses drop the report.
4. **Ticket.** The server numbers it (`MOCH-42`), logs `created`/`completed` events, and queues a `route_ticket` job.
   Routing rules either queue escalations or suggest them on the ticket.
5. **Triage.** Developers change status, assign, comment and escalate from the dashboard. Every change is an event on
   the ticket. Admin actions also go to the audit log.

## Continuous recording: the trade-offs

Video costs something on the device. Snitch's choices:

- **Default: in-app snapshots.** The SDK draws the app's own windows a few times a second
  (`drawHierarchy` on iOS, `PixelCopy` on Android). It needs no permission prompt and conflicts with nothing.
  - A governor caps the main-thread share at about 3%: 1 fps when idle, up to 4 (iOS) or 8 (Android) fps for 1.5 s
    after a touch.
  - On iOS nothing is captured during scrolling.
  - Capture pauses when the app is in the background, when the device is hot, or when the Snitch sheet is open.
  - The clip looks like a fast slideshow, with smooth touch trails drawn in at compose time.
- **Opt-in: system capture** (ReplayKit / MediaProjection). Full frame rate and close to zero CPU, but the OS asks the
  tester for consent every session. On iOS it shares the single ReplayKit recorder with the host app, so Snitch backs
  off when another recording is running.
- **Memory, not disk.** Frames are downscaled JPEGs in a RAM ring (≤ 6 MB, 30 s). Identical consecutive frames are
  stored once, and the ring is halved on a memory warning. Nothing is written until the tester sends a report.
- **Guard rails.**
  - Every report carries capture stats (frame cost p50/p95, effective fps, ring size), so real-device cost shows up
    in the dashboard.
  - A crash-loop sentinel on iOS downgrades the renderer if capture is suspected of crashing the app.
  - Remote config can switch capture modes per platform and build type without an app release.

## Release types

Store builds must be inert. The SDK classifies the running build at start:

| Signal | Release type |
|---|---|
| Simulator | debug |
| iOS profile with `get-task-allow` | debug |
| iOS profile with devices | ad hoc |
| iOS enterprise profile | enterprise |
| iOS sandbox receipt | TestFlight |
| iOS production receipt | App Store |
| Android `FLAG_DEBUGGABLE` | debug |
| Android, installed from a store | play |
| Android, any other installer | internal |

Anything ambiguous is `unknown`. The SDK only runs in the release types the app lists (default: everything except
App Store, Play and unknown). Outside them it makes no network calls at all. The server applies its own per-project
allowlist on top, and remote config can switch individual release types off.
