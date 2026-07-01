#!/usr/bin/env bash
# hosts-hijack.sh  (macOS / Linux) — requires root for enable/disable
#
# Redirect api.anthropic.com to 127.0.0.1 (or remove that redirect) in /etc/hosts,
# so Claude Code's traffic to the (RC-required) official host lands on the local
# HTTPS proxy. The managed line is tagged so it can be removed cleanly.
#
# Usage:
#   sudo scripts/hosts-hijack.sh enable
#   sudo scripts/hosts-hijack.sh disable
#   scripts/hosts-hijack.sh status
#
# SIDE EFFECT: while enabled, EVERY program on this machine resolves
# api.anthropic.com to 127.0.0.1 (browsers, plain `claude`, other SDKs). Only the
# local proxy (with the matching self-signed cert) serves it correctly.
set -euo pipefail

HOSTS="${HOSTS_FILE:-/etc/hosts}"
MARKER="# cc-split-billing"
HOST_NAME="api.anthropic.com"
LINE="127.0.0.1	$HOST_NAME	$MARKER"
ACTION="${1:-status}"

show_status() {
  if grep -q "$MARKER" "$HOSTS" 2>/dev/null; then
    echo "status: ENABLED  ->  $(grep "$MARKER" "$HOSTS")"
  else
    echo "status: disabled (no cc-split-billing hosts entry)"
  fi
}

flush_dns() {
  # best effort, per platform
  if command -v dscacheutil >/dev/null 2>&1; then dscacheutil -flushcache 2>/dev/null || true; fi
  if command -v killall >/dev/null 2>&1; then killall -HUP mDNSResponder 2>/dev/null || true; fi
  if command -v resolvectl >/dev/null 2>&1; then resolvectl flush-caches 2>/dev/null || true; fi
}

case "$ACTION" in
  status) show_status; exit 0 ;;
  enable|disable) ;;
  *) echo "usage: $0 enable|disable|status" >&2; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "hosts-hijack $ACTION needs root. Re-run:  sudo $0 $ACTION" >&2
  exit 1
fi

# Rewrite atomically: strip any existing managed line, optionally append a fresh one.
tmp="$(mktemp)"
grep -v "$MARKER" "$HOSTS" > "$tmp" 2>/dev/null || true
if [ "$ACTION" = enable ]; then printf '%s\n' "$LINE" >> "$tmp"; fi
cat "$tmp" > "$HOSTS"          # preserve original file ownership/inode perms
rm -f "$tmp"
flush_dns

if [ "$ACTION" = enable ]; then echo "hosts: ENABLED  ($HOST_NAME -> 127.0.0.1)"; else echo "hosts: disabled ($HOST_NAME redirect removed)"; fi
