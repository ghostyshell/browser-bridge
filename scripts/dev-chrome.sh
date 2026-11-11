#!/usr/bin/env bash
# Launch a throwaway Chrome profile with Browser Bridge loaded, for testing.
# Usage: scripts/dev-chrome.sh [url ...]
#
# Uses a temp profile so it never touches the real browser. The extension is
# installed over CDP (Chrome 137+ ignores --load-extension).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${BRIDGE_TEST_PROFILE:-${TMPDIR:-/tmp}/browser-bridge-profile}"
PORT="${BRIDGE_TEST_CDP_PORT:-9333}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

mkdir -p "$PROFILE"

if ! curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  "$CHROME" \
    --user-data-dir="$PROFILE" \
    --no-first-run \
    --no-default-browser-check \
    --remote-debugging-port="$PORT" \
    about:blank >"$PROFILE/chrome.log" 2>&1 &
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

node "$ROOT/dist/scripts/cdp-load-extension.js" "$ROOT/extension" "$PORT"
echo "profile: $PROFILE"
echo "cdp:     http://127.0.0.1:$PORT"
