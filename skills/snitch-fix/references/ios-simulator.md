# Reproducing on the iOS simulator

Add this project's specifics to the "This project" table in SKILL.md: the bundle id of the debug build, the simulator
it's installed on (name and UDID), and how it loads its JavaScript or code.

## Pick the simulator

- Match the reporter's phone when the bug could depend on it. The ticket summary gives the model with its name
  (`iPhone17,3 (iPhone 16)`), the screen in points, text size, dark mode and the OS. Screen size matters for layout
  and keyboard bugs; for logic, any phone will do. Note what differed.
- `xcrun simctl list devices available` lists simulators with their UDIDs.
- **Always pass the UDID, never `booted`.** With two simulators booted, `booted` picks one, and taps or screenshots
  go to the wrong one.
- Is the debug build installed? `xcrun simctl listapps <UDID> | grep <bundle id>`. If not, build it the project's way
  (e.g. `npx expo run:ios --device <UDID>`, or `xcodebuild` and `xcrun simctl install <UDID> <path>.app`). That takes
  minutes, so reuse an installed build when it's recent enough.

## Match the reporter's settings

```bash
xcrun simctl ui <UDID> appearance dark                 # or light
xcrun simctl ui <UDID> content_size extra-extra-large  # text size; `content_size` lists the values
xcrun simctl location <UDID> set 51.5072,-0.1276       # when the bug is about place
xcrun simctl status_bar <UDID> override --time 9:41    # steadier screenshots
```

Put them back afterwards (`appearance light`, `content_size large`, `status_bar <UDID> clear`).

## JavaScript apps (React Native, Expo)

- **Reuse a bundler that's already running for this repository.** `lsof -i :8081` shows one. Check it serves this
  checkout (`lsof -p <pid> | grep cwd`). Otherwise start one in the background with stdin closed, e.g.
  `npx expo start --port 8081 < /dev/null`, then `xcrun simctl launch <UDID> <bundle id>`.
- **Errors about config plugins, unknown options or missing native modules right after switching branches** usually
  mean `node_modules` belong to another branch. Run `npm ci` (or the project's install), then restart the bundler with
  its cache cleared (`--clear`), since it caches config plugins.
- Reload after a change with `xcrun simctl launch --terminate-running-process <UDID> <bundle id>`.

## Driving the app

- **Keyboard bugs need the software keyboard.** With the Mac's keyboard attached as a hardware keyboard, a focused
  field shows no keyboard and no keyboard events fire. Toggle it in Simulator with ⌘⇧K (I/O > Keyboard > Connect
  Hardware Keyboard).
- [idb](https://fbidb.io) drives the simulator without moving the real mouse:
  - `idb ui describe-all --udid <UDID>` lists elements with labels and frames (points).
  - `idb ui tap --udid <UDID> <x> <y>` taps at points: the same units as the timeline's touches.
  - `idb ui swipe --udid <UDID> <x1> <y1> <x2> <y2>`.
  - `idb ui text --udid <UDID> "words"` types into the focused field. Tap the field first: typed into nothing, a key
    like `d` can open a dev menu. Keep typed text short.
- `xcrun simctl openurl <UDID> <url>` opens a deep link, straight to the screen in question.
- `xcrun simctl push <UDID> <bundle id> payload.json` sends a push notification.

## Look

```bash
xcrun simctl io <UDID> screenshot <ticket folder>/repro-before.png
```

Save screenshots in the ticket's cache folder (where `download_ticket` puts its files), never in the repository.
Read the screenshot, compare it with the tester's, and say what matches and what doesn't. After the fix, do the same
steps and save `repro-after.png`.

Logs: `xcrun simctl spawn <UDID> log stream --predicate 'process == "<executable>"' --style compact`, or the bundler's
output for JavaScript.

## Clean up

Stop a bundler you started, shut down simulators you booted (`xcrun simctl shutdown <UDID>`), and reset the settings
you changed.
