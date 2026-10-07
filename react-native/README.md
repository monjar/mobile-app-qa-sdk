# react-native-snitch

Self-hosted QA and bug reporting for React Native and Expo apps. Testers hold
three fingers on the screen, describe the problem and send it, with a
screenshot and the last seconds of screen video attached, to **your own**
[Snitch](https://github.com/monjar/mobile-app-qa-sdk) server.

- Zero code with Expo: add the config plugin, rebuild, done. The native SDK starts itself at launch.
- Off (and network-silent) in store builds by default; on in debug, ad-hoc, TestFlight and internal builds.
- No third-party native dependencies. iOS 15.1+, Android 7.0+ (API 24).
- React Native 0.76+ with the new architecture (for the JS API). Not available in Expo Go.

## Expo

```sh
npx expo install react-native-snitch
```

```json
{
  "expo": {
    "plugins": [
      ["react-native-snitch", { "serverUrl": "https://snitch.example.com", "ingestKey": "snitch_pk_…" }]
    ]
  }
}
```

Then rebuild (`npx expo prebuild`, `npx expo run:ios`, or an EAS build).
`serverUrl` / `ingestKey` can also come from the `SNITCH_SERVER_URL` /
`SNITCH_INGEST_KEY` environment variables at prebuild time.

## Bare React Native

```sh
npm install react-native-snitch
cd ios && pod install
```

Add the `Snitch` dictionary to Info.plist and the `io.github.monjar.snitch.*`
meta-data to AndroidManifest.xml, or start from JavaScript once:

```js
import { Snitch } from 'react-native-snitch';

Snitch.start({ serverUrl: 'https://snitch.example.com', ingestKey: 'snitch_pk_…' });
```

## API

```ts
Snitch.show('bug');                                  // open the report sheet
Snitch.setUser({ id: '42', email: 'qa@example.com' });
Snitch.setMetadata('plan', 'pro');                   // null removes
Snitch.log('checkout started', 'info');
Snitch.setEnabled(false);                            // pause at runtime
Snitch.isEnabled();                                  // boolean
Snitch.releaseType();                                // 'debug' | 'testflight' | …
```

Mask sensitive views in screenshots and video with a `testID` prefix:

```tsx
<View testID="snitch-mask-card">…</View>
```

Editable text inputs are masked by default.

## Documentation

- [Expo guide](https://github.com/monjar/mobile-app-qa-sdk/blob/main/docs/expo.md): every plugin option
- [React Native guide](https://github.com/monjar/mobile-app-qa-sdk/blob/main/docs/react-native.md)

## License

MIT
