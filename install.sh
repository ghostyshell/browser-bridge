#!/usr/bin/env bash
# Install Browser Bridge: build, deps, CLI symlink, agent skill links.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
CLAUDE_SKILLS="$HOME/.claude/skills"
OPENCODE_SKILLS="$HOME/.config/opencode/skills"
SKILL_NAME="browser-control"

say() { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

step "1/6  dependencies"
( cd "$ROOT" && npm install --no-audit --no-fund --silent )
say "installed"

step "2/6  build (TypeScript -> dist/, extension/*.js)"
( cd "$ROOT" && npm run build )
say "built"

step "3/6  CLI"
chmod +x "$ROOT/bin/chromectl" "$ROOT/scripts/"*.sh "$ROOT/scripts/"*.mjs "$ROOT/scripts/"*.py 2>/dev/null || true
mkdir -p "$BIN_DIR"
ln -sf "$ROOT/bin/chromectl" "$BIN_DIR/chromectl"
say "linked $BIN_DIR/chromectl"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "WARNING: $BIN_DIR is not on PATH - add it to your shell profile" ;;
esac

step "4/6  agent skill"
mkdir -p "$CLAUDE_SKILLS" "$OPENCODE_SKILLS"
ln -sfn "$ROOT/skill" "$CLAUDE_SKILLS/$SKILL_NAME"
ln -sfn "$CLAUDE_SKILLS/$SKILL_NAME" "$OPENCODE_SKILLS/$SKILL_NAME"
say "$CLAUDE_SKILLS/$SKILL_NAME -> $ROOT/skill"
say "$OPENCODE_SKILLS/$SKILL_NAME -> $CLAUDE_SKILLS/$SKILL_NAME"

step "5/6  daemon"
"$ROOT/bin/chromectl" daemon restart >/dev/null
say "listening on http://127.0.0.1:8737"
say "token   ~/.config/browser-bridge/token (0600)"
say "log     ~/.config/browser-bridge/daemon.log"

step "6/6  load the extension in Chrome"
cat <<EOF
  It is a one-time manual step (Chrome requires a human for this):

    1. open   chrome://extensions
    2. enable Developer mode (top right)
    3. click  Load unpacked
    4. select $ROOT/extension
    5. pin "Browser Bridge" to the toolbar

  Then check everything is wired up:

    chromectl status

  The badge on the extension icon turns into a purple dot when the agent is
  connected. The first time the agent visits a site, approve it in the popup.
EOF

if [ "${1:-}" = "--open" ]; then
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
  open -R "$ROOT/extension" 2>/dev/null || true
fi

printf '\ndone.\n'
