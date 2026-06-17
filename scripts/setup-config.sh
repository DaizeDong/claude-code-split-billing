#!/usr/bin/env bash
# setup-config.sh  (macOS / Linux)
# Create an isolated Claude Code config directory and turn on Remote Control by default.
# This directory is independent of your default ~/.claude.json — they do not affect each other.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_DIR="${1:-$REPO_ROOT/.claude-config}"

mkdir -p "$CONFIG_DIR"
SF="$CONFIG_DIR/settings.json"

if command -v node >/dev/null 2>&1; then
  # Merge into any existing settings.json using Node (no extra dependency).
  SF="$SF" node -e '
    const fs=require("fs"); const p=process.env.SF;
    let j={}; try{ j=JSON.parse(fs.readFileSync(p,"utf8")); }catch{}
    j.enableRemoteControlByDefault=true;
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  '
else
  printf '{\n  "enableRemoteControlByDefault": true\n}\n' > "$SF"
fi

echo "Isolated config dir: $CONFIG_DIR"
echo "settings.json:"
cat "$SF"
echo
echo "Next: run 'cc' then /login and choose the subscription (OAuth) option."
