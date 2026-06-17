#!/usr/bin/env bash
# setup-config.sh  (macOS / Linux)
# Choose which Claude Code config directory `cc` uses, and turn on Remote Control.
#
# Modes:
#   (default / --isolated)   Isolated config dir at <repo>/.claude-config — fully independent
#                            of your normal ~/.claude. You log in separately under `cc`; no
#                            plugins/skills/sessions are shared.
#   --inherit [DIR]          Reuse your real Claude Code config (DIR, default ~/.claude) so that
#                            `cc` and `claude` SHARE everything live — login, plugins, skills,
#                            sessions, MCP servers and settings. Only inference billing differs.
#                            This writes one key (enableRemoteControlByDefault) into DIR/settings.json;
#                            all existing keys are preserved.
#
# The chosen directory is recorded in <repo>/.cc-config-dir (git-ignored), which bin/cc reads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE=isolated
INHERIT_DIR=""
POSITIONAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --inherit)
      MODE=inherit; shift
      # optional non-flag argument = the dir to inherit from
      if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then INHERIT_DIR="$1"; shift; fi
      ;;
    --isolated) MODE=isolated; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) POSITIONAL="$1"; shift ;;
  esac
done

if [ "$MODE" = inherit ]; then
  CONFIG_DIR="${INHERIT_DIR:-$HOME/.claude}"
else
  CONFIG_DIR="${POSITIONAL:-$REPO_ROOT/.claude-config}"
fi

mkdir -p "$CONFIG_DIR"
SF="$CONFIG_DIR/settings.json"

# Merge enableRemoteControlByDefault:true into settings.json without clobbering anything.
if command -v node >/dev/null 2>&1; then
  SF="$SF" node -e '
    const fs=require("fs"); const p=process.env.SF;
    let j={}; try{ j=JSON.parse(fs.readFileSync(p,"utf8")); }catch{}
    j.enableRemoteControlByDefault=true;
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  '
else
  # No node available: only safe to create the file if it does not already exist.
  [ -f "$SF" ] || printf '{\n  "enableRemoteControlByDefault": true\n}\n' > "$SF"
fi

# Record the chosen dir so bin/cc uses it (git-ignored; may contain a personal path).
printf '%s\n' "$CONFIG_DIR" > "$REPO_ROOT/.cc-config-dir"

echo "Mode:                 $MODE"
echo "Config dir cc uses:   $CONFIG_DIR"
echo "Pointer written to:   $REPO_ROOT/.cc-config-dir"
if [ "$MODE" = inherit ]; then
  echo
  echo "cc now SHARES this config with your normal 'claude': login, plugins, skills,"
  echo "sessions, MCP and settings are the same and update both ways. Only inference"
  echo "billing differs (cc -> gateway, claude -> subscription)."
  echo "Added enableRemoteControlByDefault to $SF (existing keys preserved)."
  echo "If that directory is already OAuth-logged-in for 'claude', 'cc' needs no /login."
else
  echo
  echo "Isolated config — independent of ~/.claude."
  echo "Next: run 'cc' then /login and choose the subscription (OAuth) option."
fi
