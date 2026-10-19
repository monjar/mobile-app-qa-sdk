# Reproducing on the Android emulator

Add this project's specifics to the "This project" table in SKILL.md: the debug build's package name, the emulator
(AVD) to use, and how it loads its JavaScript or code.

## Pick the emulator

- Match the reporter's device when the bug could depend on it. The ticket summary gives the manufacturer and model,
  the screen in dp, text size, dark mode and the Android version. Note what differed.
- `emulator -list-avds` lists emulators; `emulator -avd <name> -no-snapshot-load &` starts one; `adb devices` lists
  what's running.
- **Always pass the serial (`adb -s emulator-5554 …`).** With a phone plugged in as well, a bare `adb` refuses or
  picks the wrong one.
- Is the debug build installed? `adb -s <serial> shell pm list packages | grep <package>`. If not, build it the
  project's way (e.g. `npx expo run:android`, or `./gradlew installDebug`).

## Match the reporter's settings

```bash
adb -s <serial> shell cmd uimode night yes                   # dark mode (no to undo)
adb -s <serial> shell settings put system font_scale 1.3     # text size (1.0 to undo)
adb -s <serial> shell wm size 1080x2400                      # screen size (wm size reset to undo)
adb -s <serial> emu geo fix -0.1276 51.5072                  # location: longitude, then latitude
```

Put them back afterwards.

## JavaScript apps (React Native, Expo)

- Reuse a bundler already serving this checkout (`lsof -i :8081`), or start one in the background with stdin closed.
- `adb -s <serial> reverse tcp:8081 tcp:8081` lets the emulator reach it.
- Errors about config plugins or missing native modules right after switching branches usually mean `node_modules`
  belong to another branch: reinstall, then restart the bundler with its cache cleared.
- Restart the app: `adb -s <serial> shell am force-stop <package> && adb -s <serial> shell monkey -p <package> 1`.

## Driving the app

- `adb shell input` works in **pixels**; the timeline's touches are in dp. Multiply by the emulator's density over
  160 (`adb shell wm density`, e.g. 420 → ×2.625). The reporter's own is the `@Nx` in the ticket's device line.
- `adb -s <serial> shell input tap <x> <y>`, `… input swipe <x1> <y1> <x2> <y2> 300`, `… input text "words"` (spaces
  as `%s`), `… input keyevent KEYCODE_BACK`.
- Element bounds (pixels): `adb -s <serial> shell uiautomator dump /sdcard/ui.xml && adb -s <serial> pull
  /sdcard/ui.xml`.
- Deep link: `adb -s <serial> shell am start -a android.intent.action.VIEW -d "<url>" <package>`.

## Look

```bash
adb -s <serial> exec-out screencap -p > <ticket folder>/repro-before.png
```

Save screenshots in the ticket's cache folder, never in the repository. Read the screenshot, compare it with the
tester's, and say what matches. After the fix, the same steps give `repro-after.png`.

Logs: `adb -s <serial> logcat -d --pid=$(adb -s <serial> shell pidof <package>)`.

## Clean up

Stop a bundler you started, close emulators you started (`adb -s <serial> emu kill`), and reset the settings you
changed.
