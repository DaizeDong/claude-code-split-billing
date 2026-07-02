#!/usr/bin/env bash
# gen-certs.sh
# Generate a local CA and a leaf certificate for api.anthropic.com, so the local
# HTTPS proxy can terminate TLS for the (hosts-hijacked) api.anthropic.com and
# Node/Claude Code trusts it via NODE_EXTRA_CA_CERTS.
#
# Outputs (all under <repo>/certs, git-ignored):
#   certs/ca.key      local CA private key            (NEVER commit)
#   certs/ca.pem      local CA cert  -> NODE_EXTRA_CA_CERTS (= ca-bundle.pem)
#   certs/server.key  leaf private key for the proxy  (NEVER commit)
#   certs/server.pem  leaf cert (CN/SAN = api.anthropic.com)
# Also copies certs/ca.pem to <repo>/ca-bundle.pem (what bin/cc feeds Node).
#
# Idempotent-ish: pass --force to regenerate. Requires openssl.
set -euo pipefail

# Git Bash/MSYS rewrites args that look like Unix paths (e.g. openssl -subj "/CN=..."),
# corrupting the DN. Disable that here; harmless on macOS/Linux (var simply unused).
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$REPO_ROOT/certs"
DAYS_CA=3650
DAYS_LEAF=825          # <=825 keeps within common leaf-validity limits
LEAF_HOST="api.anthropic.com"

command -v openssl >/dev/null 2>&1 || { echo "gen-certs: openssl not found on PATH." >&2; exit 1; }

if [ -f "$CERT_DIR/server.pem" ] && [ "${1:-}" != "--force" ]; then
  echo "gen-certs: certs already exist in $CERT_DIR (pass --force to regenerate)."
  exit 0
fi

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

echo "gen-certs: creating local CA..."
openssl genrsa -out ca.key 2048 2>/dev/null
openssl req -x509 -new -nodes -key ca.key -sha256 -days "$DAYS_CA" \
  -out ca.pem -subj "/CN=cc-split-billing local CA/O=cc-split-billing" 2>/dev/null

echo "gen-certs: creating leaf cert for $LEAF_HOST..."
openssl genrsa -out server.key 2048 2>/dev/null
openssl req -new -nodes -key server.key -out server.csr \
  -subj "/CN=$LEAF_HOST" 2>/dev/null

cat > server.ext <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$LEAF_HOST
EOF

openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
  -out server.pem -days "$DAYS_LEAF" -sha256 -extfile server.ext 2>/dev/null

rm -f server.csr server.ext ca.srl

# What bin/cc feeds Node so it trusts our leaf.
cp ca.pem "$REPO_ROOT/ca-bundle.pem"

echo "gen-certs: done."
echo "  CA      : $CERT_DIR/ca.pem  (also copied to $REPO_ROOT/ca-bundle.pem)"
echo "  leaf    : $CERT_DIR/server.pem  (CN/SAN=$LEAF_HOST)"
echo "  keys    : $CERT_DIR/{ca,server}.key  (git-ignored, keep private)"
