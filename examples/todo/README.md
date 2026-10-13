# Snitch example: a todo app

A small Expo SDK 52 todo list with Snitch added through the config plugin and nothing else in
the code but one `Snitch.setScreen` call. It has a bug on purpose: ticking a todo saves it with
`PATCH /todo/:id` (it should be `/todos/:id`), the API answers 404, and the app rolls the tick
back. A report filed right after shows the request, the warning the app logged, and the last few
seconds of video, which is the whole point of the demo.

- Tap a row to tick it, hold it for 600 ms to delete it (no confirmation, on purpose: the
  three-finger hold has to cancel that long-press, never trigger it).
- The "Add a todo" field is an editable text input, so it is masked in screenshots and video.
- `captureNetwork` is on, so requests to `jsonplaceholder.typicode.com` land in the timeline.

## Run it

```sh
(cd ../../react-native && npm install)
npm install
npx expo run:ios
```

The plugin points the app at `http://127.0.0.1:8080`; start a server with
`bash ../../scripts/ci-start-server.sh` from the repo root (admin `ci@snitch.local` /
`ci-password-123`), then hold three fingers on the screen.

## CI

`.github/workflows/todo-demo.yml` builds it for the simulator and takes the screenshots used in
the docs: the tester notice, the list, the report sheet, and the rollback. Launched with
`-demo story`, the app plays a short scripted session by itself (switch tabs, add a todo, tick
"Buy oat milk"), and Snitch's debug autoreport then files a real report from it.
