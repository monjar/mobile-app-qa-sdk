#!/usr/bin/env bash
# Builds and starts a Snitch server for CI end-to-end jobs, seeded with:
#   project "ci" (prefix CI), ingest key snitch_pk_0123456789ABCDEFGHJKMNPQRS
#   admin ci@snitch.local / ci-password-123
# Listens on 0.0.0.0:8080 (the Android emulator reaches it at 10.0.2.2:8080).
# Leaves the server running in the background; logs go to $SNITCH_LOG.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SNITCH_DATA_DIR="${SNITCH_DATA_DIR:-${RUNNER_TEMP:-/tmp}/snitch-ci}"
export SNITCH_PUBLIC_URL="${SNITCH_PUBLIC_URL:-http://127.0.0.1:8080}"
export SNITCH_LOG="${SNITCH_LOG:-${RUNNER_TEMP:-/tmp}/snitch-server.log}"
export PORT="${PORT:-8080}"
# CI devices all share one address; don't let the per-IP limits get in the way.
export SNITCH_REPORTS_PER_IP_PER_10_MIN=1000

cd "$ROOT"
if [ ! -d node_modules ]; then npm ci --no-audit --no-fund; fi
npm run build -w server >/dev/null

rm -rf "$SNITCH_DATA_DIR"
node server/dist/cli.js project:create --name CI --slug ci --prefix CI --ingest-key snitch_pk_0123456789ABCDEFGHJKMNPQRS
node server/dist/cli.js user:create --email ci@snitch.local --password ci-password-123

nohup node server/dist/index.js >"$SNITCH_LOG" 2>&1 &
echo $! > "${RUNNER_TEMP:-/tmp}/snitch-server.pid"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Snitch server is up on :$PORT (log: $SNITCH_LOG)"
    exit 0
  fi
  sleep 1
done
echo "Snitch server did not start; log follows:" >&2
cat "$SNITCH_LOG" >&2
exit 1
