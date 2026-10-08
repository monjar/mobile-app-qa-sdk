# Snitch

Self-hosted QA and bug reporting for mobile apps.

Testers hold **three fingers** on the screen. A small sheet slides up where they pick *Bug*, *Idea* or *Other*,
describe what happened, and send. The current screen is attached automatically, and so are the last
**1–30 seconds of screen video** if they want. Reports land on **your server** as tickets, where your team triages
them and escalates to **GitHub issues, email, Slack, Discord or any webhook**, with routing by report type.

- **iOS** (Swift Package), **Android** (Kotlin), **React Native / Expo** (one package, zero code with the config plugin)
- **Lightweight.** No dependencies in the native cores. Recent screen frames live only in RAM. Capture work is capped
  at about 3% of the main thread.
- **Safe by default.** Store builds are inert, text fields are masked, nothing leaves the device unless a tester
  sends it, and the server runs on your own infrastructure.
- **One container** for the server: SQLite plus a volume, or S3. Run it with `docker run`, Compose with automatic TLS,
  or Fly.io.

## Quick start

**1. Run the server**

```sh
docker run -d --name snitch -p 8080:8080 -v snitch-data:/data \
  -e SNITCH_PUBLIC_URL=https://snitch.example.com ghcr.io/monjar/snitch-server:latest
docker logs snitch | grep setup
```

The log line is a one-time link to create the first admin. Then create a project in the dashboard and copy its ingest key.

**2. Add the SDK**

| Platform | Install | Code |
|---|---|---|
| Expo | `npx expo install react-native-snitch` + plugin entry in `app.json` | none |
| React Native | `npm i react-native-snitch && cd ios && pod install` | `Snitch.start({ serverUrl, ingestKey })` |
| iOS | Swift Package `https://github.com/monjar/mobile-app-qa-sdk`, product `Snitch` | `Snitch.start(serverURL:ingestKey:)` |
| Android | JitPack `com.github.monjar.mobile-app-qa-sdk:snitch` | manifest meta-data, or `Snitch.start(context, url, key)` |

```jsonc
// app.json (Expo)
{
  "expo": {
    "plugins": [
      ["react-native-snitch", {
        "serverUrl": "https://snitch.example.com",
        "ingestKey": "snitch_pk_…",
        "enabledReleaseTypes": ["debug", "adhoc", "testflight", "internal"]
      }]
    ]
  }
}
```

**3. Shake out some bugs.** Build the app, hold three fingers on the screen, send a report, and watch it appear in the
inbox.

## Docs

- [Server: install, configure, operate](docs/server.md)
- [iOS](docs/ios.md) · [Android](docs/android.md) · [React Native](docs/react-native.md) · [Expo](docs/expo.md)
- [Architecture and trade-offs](docs/architecture.md)
- [Privacy and data handling](docs/privacy.md)
- [SDK behaviour spec](docs/sdk-spec.md), the source of truth for the native implementations
- [Integrating into Mochiro](docs/mochiro.md)

## Repository layout

```
contract/       wire schemas, fixtures, reference logic + shared test vectors
server/         Node 24 · Hono · SQLite: intake, admin API, worker, Docker
dashboard/      React admin SPA, served by the server
ios/            Swift core (SwiftPM manifest at the repo root: Package.swift)
android/        Kotlin core + optional system-capture module
react-native/   npm react-native-snitch: TurboModule + Expo config plugin
examples/       sample apps used by CI (iOS, Android, Expo 52, latest Expo)
scripts/        fake SDK client, CI helpers, packaging checks
```

## Development

```sh
npm ci
npm test
npm run build
npm run dev -w server
npm run dev -w dashboard
node scripts/fake-sdk.mjs --key snitch_pk_… --generate-media 5
```

`npm test` runs the contract and server tests, and `npm run build` builds the dashboard and the server bundle. The dev
server serves the API on :8080 (data in `SNITCH_DATA_DIR`, default `./data`), and the dashboard dev server runs on
:5173, proxied to :8080. `fake-sdk.mjs` sends a report the way a device would.

Native code is built and tested in GitHub Actions (`ios.yml`, `android.yml`, `rn.yml`). The Kotlin pure logic also runs
on a plain JVM: `gradle -p android/logic-jvm test`.

## License

MIT
