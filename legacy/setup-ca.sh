#!/usr/bin/env bash
# setup-ca.sh  (macOS / Linux)
# Build a CA bundle so Node trusts your corporate TLS-intercepting root CA
# (via NODE_EXTRA_CA_CERTS). This fixes "unable to get local issuer certificate",
# which otherwise makes Remote Control eligibility checks fail and the flag be ignored.
#
# You only need this if your network performs TLS interception. On a normal network
# the control-plane test already passes and you can skip CA setup entirely.
#
# Usage:
#   Diagnose (print the issuer of the live certs, so you know your root CA):
#     scripts/setup-ca.sh --diagnose
#   Build the bundle from a PEM file you already have (the corporate root CA):
#     scripts/setup-ca.sh /path/to/corporate-root-ca.pem
#   Then test:
#     scripts/setup-ca.sh --test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/ca-bundle.pem"
HOSTS=(api.anthropic.com mcp-proxy.anthropic.com claude.ai)

diagnose() {
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl not found; cannot diagnose. Install openssl or inspect the cert manually." >&2
    exit 1
  fi
  echo "=== Diagnose: issuer of the live control-plane certs ==="
  echo "If the issuer is NOT Anthropic/its public CA, that is your corporate root CA."
  echo "Export that root CA to a PEM and pass it to this script."
  echo
  for h in "${HOSTS[@]}"; do
    echo "$h:"
    echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null \
      | openssl x509 -noout -issuer -subject 2>/dev/null || echo "  (failed to connect)"
    echo
  done
}

run_test() {
  if [ -f "$OUT" ]; then export NODE_EXTRA_CA_CERTS="$OUT"; fi
  node "$SCRIPT_DIR/test-control-plane.js"
}

case "${1:-}" in
  --diagnose) diagnose ;;
  --test) run_test ;;
  '' )
    echo "Usage: setup-ca.sh --diagnose | <root-ca.pem> | --test" >&2
    exit 1 ;;
  * )
    SRC="$1"
    if [ ! -f "$SRC" ]; then echo "No such PEM file: $SRC" >&2; exit 1; fi
    cp "$SRC" "$OUT"
    echo "Wrote $OUT"
    echo
    echo "=== Node TLS connectivity test (using the exported bundle) ==="
    run_test || echo "Some hosts failed; verify $SRC is the full corporate root CA chain."
    ;;
esac
