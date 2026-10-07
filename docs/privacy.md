# Privacy and data handling

Snitch is self-hosted. Reports go from the device to **your** server and nowhere else, unless you escalate them.

## On the device

- **Nothing runs in store builds by default.** App Store, Google Play and undetermined builds are excluded unless the
  app opts them in. When excluded, the SDK installs no observers and makes no network requests.
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

## What a report contains

- Report type, description, and optionally the tester's email.
- The screenshot and video, if ticked, and log lines if the app provides a log provider.
- App id, version, build, and release type.
- Device model, OS version, locale, time zone, screen size, memory use, battery and charging state, network type
  (Wi-Fi or cellular, no identifiers), dark mode, screen reader on/off, and font scale.
- Snitch's capture statistics, and any custom metadata the app sets with `setMetadata` / `setUser`.

**Not collected:** advertising ids, location, contacts, device identifiers, or any data from other apps.

## On the server

- Attachments are only served to signed-in dashboard users, or through share links you create explicitly.
  Share links are random, revocable, and expire after 30 days by default.
- Tickets and their media are deleted after the retention period (90 days by default, configurable per project).
  Admins can delete a ticket at any time.
- Integration tokens are encrypted at rest. They are never returned by the API.

## App Store / Play declarations

The iOS core ships a `PrivacyInfo.xcprivacy` declaring:

- UserDefaults access (reason `CA92.1`).
- Collected data types: "Other Diagnostic Data" and "Other User Content", not linked to identity, used for app
  functionality, no tracking.

If you enable Snitch in a store build, reflect that in your App Store privacy answers and Play data-safety form.
