# Privacy and data handling

Snitch is self-hosted. Reports go from the device to **your** server and nowhere else, unless you escalate them.

## On the device

- **Nothing runs in store builds by default.** App Store, Google Play and undetermined builds are excluded unless the
  app opts them in. When excluded, the SDK installs no observers and makes no network requests. The one exception is
  opt-in: with `checkInWhenInactive`, a build whose release type could not be determined (`unknown`, never App Store
  or Play) sends one config request per launch so the Devices page shows it. It carries no screen content.
- **The screen buffer never leaves RAM.** In enabled builds, the last ~30 s of the screen are kept as small JPEG
  frames in memory (≤ 6 MB). They're discarded continuously and written nowhere. They are only used if the tester
  sends a report with video ticked.
- **Masking.** Editable text fields (passwords, search fields, React Native `TextInput`) are blacked out in both the
  screenshot and the video by default. Mask any other view with `Snitch.mask(view)` or a `snitch-mask…` test id /
  accessibility identifier.
- **Consent.** The first time Snitch is active on a device it shows a one-time notice. The notice explains the
  gesture and that recent screen activity stays on the device unless the tester sends a report. The tester sees the
  screenshot before sending and can untick it, the video, or both. "Pause recording" in the sheet stops capture until
  the next launch.
- **Pending reports** wait in the app's private storage (excluded from backups) until uploaded, at most 10 reports or
  100 MB.
- **The timeline stays in RAM too.** Recent log lines, request summaries, screen names, touch-down positions and app
  foreground/background events are kept in memory (5 minutes at most) and only sent as part of a report. With the
  crash prompt on, up to 200 recent log lines are also saved to the app's private storage every 30 seconds, so a
  report about an unexpected exit can include them; they are replaced continuously and deleted once reported or dismissed.
- **Network capture is off unless the app turns it on.** When on, a request is recorded as method, URL with every
  query value replaced by `*`, status, timing and sizes. Headers, cookies and bodies are never read. Requests to the
  Snitch server itself are never recorded.
- **Screenshot markup.** The tester can blur parts of the screenshot before sending. Blurring changes the pixels, so
  the original content is not in the uploaded file.

## What a report contains

- Report type, description, and optionally the tester's email.
- The screenshot and video, if ticked, and log lines if the app provides a log provider.
- The timeline (`timeline` attachment): console lines of this app's process (Snitch.log, React Native console,
  os_log / logcat), sanitized request summaries if network capture is on, screen names, touch-down positions, and
  foreground/background events from the last few minutes. Remote config can switch each part off per release type.
- For a report about an unexpected exit: the system's crash diagnostic (MetricKit on iOS, the uncaught exception or
  ApplicationExitInfo on Android) and the previous session's saved log lines.
- A random install id (created on first activation, not derived from any device identifier, reset on reinstall),
  which links reports to the install's row on the Devices page, and the release-type detection signals.
- App id, version, build, and release type.
- Device model, OS version, locale, time zone, screen size, memory use, battery and charging state, network type
  (Wi-Fi or cellular, no identifiers), dark mode, screen reader on/off, and font scale.
- Snitch's capture statistics, and any custom metadata the app sets with `setMetadata` / `setUser`.

**Not collected:** advertising ids, location, contacts, device identifiers (the install id is random and per install),
request or response headers and bodies, or any data from other apps.

## On the server

- Attachments are only served to signed-in dashboard users, or through share links you create explicitly.
  Share links are random, revocable, and expire after 30 days by default.
- Tickets and their media are deleted after the retention period (90 days by default, configurable per project).
  Admins can delete a ticket at any time.
- Integration tokens and webhook secrets are encrypted at rest. They are never returned by the API.
- Install check-ins (install id, app and OS version, model, SDK version, release-type signals) are kept for 180 days
  after an install was last seen.
- Optional notifications email a ticket's assignee, and, if the project turns it on, the tester who left an email
  when their ticket is resolved (ticket key, title and the build it's fixed in; never comments).
- Scheduled backups copy the database (tickets, users, settings; not the media files) to the configured bucket.

## App Store / Play declarations

The iOS core ships a `PrivacyInfo.xcprivacy` declaring:

- UserDefaults access (reason `CA92.1`).
- Collected data types: "Other Diagnostic Data" and "Other User Content", not linked to identity, used for app
  functionality, no tracking.

If you enable Snitch in a store build, reflect that in your App Store privacy answers and Play data-safety form.
