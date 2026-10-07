#!/usr/bin/env bash
# Picks an available iPhone simulator on the newest iOS runtime the selected Xcode supports, boots
# it, and exports its UDID (stdout, $GITHUB_OUTPUT `udid`, $GITHUB_ENV `UDID`).
# Runner images change their simulator line-up often; never hard-code a name.
set -euo pipefail

json="$(xcrun simctl list devices available -j)"
# Runtimes newer than the selected Xcode's SDK (e.g. a beta runtime on the image) can't run tests.
sdk="$(xcrun --sdk iphonesimulator --show-sdk-version 2>/dev/null || echo 999.0)"
echo "iphonesimulator SDK: $sdk" >&2

picked="$(printf '%s' "$json" | SDK_VERSION="$sdk" python3 -c '
import json, os, re, sys

parts = (os.environ.get("SDK_VERSION", "999.0").split(".") + ["0"])[:2]
sdk = (int(parts[0]), int(parts[1]))
devices = json.load(sys.stdin).get("devices", {})
best = None
for runtime, entries in devices.items():
    m = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not m:
        continue
    version = (int(m.group(1)), int(m.group(2)))
    if version > sdk:
        continue
    for d in entries:
        if not d.get("isAvailable", True) or not d.get("name", "").startswith("iPhone"):
            continue
        # Newest runtime first; within it prefer the plain "iPhone NN" models.
        plain = 0 if re.fullmatch(r"iPhone \d+", d["name"]) else 1
        key = (version, -plain, d["name"])
        if best is None or key > best[0]:
            best = (key, d["udid"], d["name"], version)
if best is None:
    sys.exit("no available iPhone simulator")
print("%s|%s|iOS %d.%d" % (best[1], best[2], best[3][0], best[3][1]))
')"

udid="${picked%%|*}"
rest="${picked#*|}"
name="${rest%%|*}"
os="${rest#*|}"
echo "Using simulator: $name ($os) $udid" >&2

xcrun simctl boot "$udid" >/dev/null 2>&1 || true
xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || true

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "udid=$udid"
    echo "name=$name"
    echo "os=$os"
  } >> "$GITHUB_OUTPUT"
fi
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "UDID=$udid" >> "$GITHUB_ENV"
fi
echo "$udid"
