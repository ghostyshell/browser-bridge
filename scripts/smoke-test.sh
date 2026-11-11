#!/usr/bin/env bash
# End-to-end smoke test against a throwaway Chrome profile.
# Exercises: daemon, extension socket, permission gate, snapshot, click, type,
# select, wait, eval, screenshot, tab group lifecycle.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_PORT="${BRIDGE_TEST_CDP_PORT:-9333}"
FIXTURE_PORT="${BRIDGE_FIXTURE_PORT:-8899}"
PROFILE="${BRIDGE_TEST_PROFILE:-${TMPDIR:-/tmp}/browser-bridge-profile}"
CTL="$ROOT/bin/chromectl"
ORIGIN="http://127.0.0.1:$FIXTURE_PORT"
PASS=0
FAIL=0

say() { printf '%s\n' "$*"; }
check() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == *"$want"* ]]; then
    say "  ok    $name"
    PASS=$((PASS + 1))
  else
    say "  FAIL  $name"
    say "        expected to contain: $want"
    say "        got: $got"
    FAIL=$((FAIL + 1))
  fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  # The throwaway browser must not outlive the run: the daemon pins the first
  # connected client, so a leftover test Chrome silently takes every later
  # command (and reports its own empty permission storage).
  pkill -f "user-data-dir=${PROFILE}" 2>/dev/null
}
trap cleanup EXIT

say "1. fixture server on $ORIGIN"
python3 -m http.server "$FIXTURE_PORT" --bind 127.0.0.1 --directory "$ROOT/scripts" >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1
check "fixture reachable" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/fixture.html")"

say "2. daemon + throwaway Chrome"
"$ROOT/install.sh" >/dev/null 2>&1 || { "$CTL" daemon start >/dev/null; }
BRIDGE_TEST_PROFILE="$PROFILE" "$ROOT/scripts/dev-chrome.sh" >/dev/null || { say "could not launch test Chrome"; exit 1; }
sleep 2
check "extension connected" '"extensionConnected":true' "$(curl -s http://127.0.0.1:8737/health)"

say "3. permission gate"
node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
  "chrome.storage.local.set({allowedOrigins:[],pendingOrigin:null,autoAllow:false}).then(()=>'reset')" >/dev/null
OUT="$("$CTL" open "$ORIGIN/fixture.html" 2>&1)"
check "blocked before approval" "origin_not_allowed" "$OUT"
node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" \
  "chrome.storage.local.set({allowedOrigins:['$ORIGIN'],pendingOrigin:null}).then(()=>'allowed')" >/dev/null
check "origin is approved" "$ORIGIN" "$(node "$ROOT/dist/scripts/cdp-ext-eval.js" "$ROOT/extension" "$CDP_PORT" "chrome.storage.local.get('allowedOrigins').then(v=>JSON.stringify(v.allowedOrigins))")"

say "4. page interaction"
"$CTL" reset >/dev/null 2>&1
OUT="$("$CTL" open "$ORIGIN/fixture.html" 2>&1)"
check "tab opened in group" "opened tab" "$OUT"
OUT="$("$CTL" snapshot --no-text)"
check "snapshot finds heading" 'heading1 "Bridge fixture"' "$OUT"
check "snapshot finds textbox" 'textbox "Your name"' "$OUT"
check "refs are numbered" '[0] heading1' "$OUT"

"$CTL" type 2 "Ada Lovelace" >/dev/null
"$CTL" select 3 Pro >/dev/null
"$CTL" click 4 >/dev/null
"$CTL" click 5 >/dev/null
check "form submitted" "hello Ada Lovelace (pro, agreed)" "$("$CTL" eval "document.getElementById('result').textContent")"

"$CTL" click 6 >/dev/null
OUT="$("$CTL" wait css=#later --timeout 5000 2>&1)"
check "async element appeared" "found after" "$OUT"

"$CTL" click 8 >/dev/null
"$CTL" click 8 >/dev/null
check "repeated clicks" "Clicked 2" "$("$CTL" eval "document.getElementById('counter').textContent")"

OUT="$("$CTL" screenshot 2>&1)"
SHOT="$(printf '%s\n' "$OUT" | head -1)"
check "screenshot written" ".png" "$SHOT"
if [ -f "$SHOT" ]; then
  say "  ok    screenshot file exists"
  PASS=$((PASS + 1))
else
  say "  FAIL  screenshot file missing: $SHOT"
  FAIL=$((FAIL + 1))
fi

say "5. navigation + ref expiry"
"$CTL" click 1 >/dev/null 2>&1
"$CTL" wait url=/page2.html --timeout 5000 >/dev/null
sleep 0.5
check "navigated to page two" 'heading1 "Page two"' "$("$CTL" snapshot --no-text)"

say "6. group lifecycle"
"$CTL" reset >/dev/null
check "window survived reset" '"extensionConnected":true' "$(curl -s http://127.0.0.1:8737/health)"
check "no agent tabs left" "no agent tabs" "$("$CTL" tabs)"

say ""
say "passed $PASS, failed $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
