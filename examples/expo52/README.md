# Snitch example: Expo SDK 52

Expo 52 / React Native 0.76.9 with the new architecture, Reanimated 3, Gesture Handler 2.20 and
Skia 1.5 (the same stack as Mochiro). One screen exercises what a report must get right:
long-press rows and a two-finger pan (touch cancellation), an animated Skia canvas (Metal
content in the video), a `TextInput` and a `testID="snitch-mask-…"` view (masking), and a
"Report" button (`Snitch.show()`).

`plugins/withFmtXcode26Patch.js` (copied from mochiro-mobile) lets RN 0.76 build with Xcode 26.

## Local development

`react-native-snitch` is a `file:../../react-native` dependency, installed as a symlink, so
edits to the package are picked up live (`metro.config.js` handles the symlink). npm runs the
package's `prepare` (native sync + TypeScript build) on install, so install it first:

```sh
(cd ../../react-native && npm install)
npm install
npx expo run:ios        # or run:android; the plugin points the app at http://127.0.0.1:8080
```

## CI

`.github/workflows/rn.yml` installs the packed tarball instead, exactly as users get it:

```sh
npm pkg set dependencies.react-native-snitch=file:../../rn-tarball/react-native-snitch-0.1.0.tgz
npm install
npx expo prebuild
```
