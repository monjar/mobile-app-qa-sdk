# Snitch in Mochiro

Mochiro (Expo 52, RN 0.76, iOS) uses Snitch through configuration only. Its own source (`src/`, `app/`,
`modules/`, `scripts/`) is untouched.

## What changes in `mochiro-mobile`

| File | Change |
|---|---|
| `package.json` / `package-lock.json` | `"react-native-snitch": "^0.1.0"` |
| `app.json` → `expo.plugins` | the entry below |

```json
["react-native-snitch", {
  "serverUrl": "https://mochiro-snitch.fly.dev",
  "ingestKey": "snitch_pk_5RC0ZGHHBTYSTSWPWY17N0N4MK",
  "enabledReleaseTypes": ["debug", "adhoc", "testflight"],
  "captureMode": "snapshot",
  "maskTextInputs": true,
  "screenshotPrompt": true
}]
```

**Why this works without code.** The config plugin writes the `Snitch` dictionary into Info.plist on every
`expo prebuild`, and `scripts/release-ios.sh` already runs `prebuild --clean`. The pod's `+load` hook then starts
Snitch at launch.

**Release types.** The TestFlight binary is the same one that later ships to the App Store, so Snitch decides at
runtime:

| Build | How it's made | Snitch |
|---|---|---|
| Debug | `npm run ios` (Xcode) | on |
| Ad hoc | EAS `preview` | on |
| TestFlight | `release-ios.sh` | on |
| App Store | same binary as TestFlight | off: no observers, no network |

**Why snapshot mode.** It doesn't use ReplayKit, so it can't collide with Script Studio's recorder
(`modules/mochiro-screen-recorder`).

**The ingest key is public.** It ships inside the app and can only create reports for this one project. Rotate it
from the dashboard if needed.

## Server: `mochiro-snitch` on Fly.io

This is a separate app from `mochiro-server`, so neither can take the other down.

In an empty folder (the example config already has `app = "mochiro-snitch"` and the matching `SNITCH_PUBLIC_URL`;
the password needs at least 10 characters):

```sh
curl -o fly.toml https://raw.githubusercontent.com/monjar/mobile-app-qa-sdk/master/server/fly.toml.example
fly apps create mochiro-snitch
fly volumes create snitch_data --size 3 --region lhr
fly secrets set SNITCH_BOOTSTRAP_ADMIN_EMAIL=you@example.com SNITCH_BOOTSTRAP_ADMIN_PASSWORD='…'
fly deploy --image ghcr.io/monjar/snitch-server:latest
```

Optional, for email escalation:

```sh
fly secrets set SNITCH_SMTP_URL='smtps://user:pass@smtp.example.com:465' SNITCH_MAIL_FROM='Mochiro QA <qa@mochiro.co.uk>'
```

Register the key the app is built with. The machine stops when idle, so wake it first:

```sh
curl https://mochiro-snitch.fly.dev/health
fly ssh console -C "snitch project:create --name Mochiro --slug mochiro --prefix MOCH --ingest-key snitch_pk_5RC0ZGHHBTYSTSWPWY17N0N4MK"
```

Then, in the dashboard at `https://mochiro-snitch.fly.dev`:

1. **Mochiro → Settings → General → Accepted app ids**: `com.mochiro.app`
2. **Integrations**:
   - GitHub, repo `Pamirmali/mochiro-mobile`, with a fine-grained PAT that has *Issues: write*.
   - Optionally email or Slack.
3. **Routing**: *Bug → GitHub (automatically)*, *Idea → email (suggest)*.

Leave *Include public links* off for GitHub. Mochiro's screens show health and personal data, so media should stay
behind the dashboard login.

## Shipping

- Build TestFlight the usual way: `scripts/release-ios.sh --bump`. Nothing else changes.
- For a quick local check, an EAS `preview` build or `npm run ios` also has Snitch enabled.
- **Rolling back** means removing the plugin entry and the dependency. Snitch leaves no data behind on devices
  beyond pending reports in Application Support.

## Optional: attach Mochiro's logs

This needs a few lines in Mochiro's source, so it is not done by default. Forward Mochiro's in-memory logger to
Snitch's log ring, which is attached to reports as `logs.txt`. In `app/_layout.tsx`, at module scope:

```ts
import { Snitch } from 'react-native-snitch';
import { useLogStore } from '../src/log/logger';

let lastLogId = 0;
useLogStore.subscribe((s) => {
  for (const e of s.entries) if (e.id > lastLogId) (lastLogId = e.id), Snitch.log(`[${e.tag}] ${e.message}`, e.level);
});
```

## Privacy copy

Mochiro's About screen says "no analytics SDK". That stays true for App Store users, because Snitch is inert there.
TestFlight testers see Snitch's one-time notice explaining the three-finger gesture, and that recent screen activity
stays on the phone unless they send a report. Consider adding a line about it to the TestFlight "What to Test" notes.

## Device checklist (TestFlight build)

1. **Gesture opens the sheet without side effects.** Hold three fingers for about half a second on each of:
   - the face (at most a pet "boop"),
   - a list row (must not delete),
   - an alarm row (no 600 ms action),
   - the focus screen's end button (must not end the session).
2. The lockdown two-finger, 3-second escape still works.
3. The lockdown safe word is greyed out in the screenshot and the video.
4. A 15-second video shows the Skia face and touch trails.
5. Airplane mode → send → back online: the report arrives once.
6. Across about 10 reports, the ticket's *Capture* panel shows frame cost p95 under about 25 ms and a buffer under 6 MB.
7. No `drawViewHierarchyInRect` crashes appear in TestFlight crash reports.
8. After App Store release, the gesture does nothing and the server sees no config requests with `releaseType=appstore`.
