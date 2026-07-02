# Legacy: hosts-hijack + TLS-MITM approach (deprecated)

These scripts implement the **old** way `cc` kept Remote Control working while routing
inference to a gateway. It is kept here for reference only — the current `cc` uses the
`ANTHROPIC_UNIX_SOCKET` approach instead (see the top-level README), which needs none of
this and, crucially, **does not affect plain `claude`**.

## Why it was replaced

The old approach made Remote Control's `host === "api.anthropic.com"` check pass by:

1. Hijacking `api.anthropic.com` → `127.0.0.1` in the system **hosts file**
   (`hosts-hijack.ps1` / `hosts-hijack.sh`), and
2. Running a local **HTTPS proxy on port 443** that terminated TLS with a **self-signed
   leaf** for `api.anthropic.com` (`gen-certs.sh`), trusted via `NODE_EXTRA_CA_CERTS`
   (`setup-ca.*`).

The fatal flaw for isolation: the hosts entry is **machine-global**, so plain `claude`
(which does not trust the self-signed CA) also resolved to the proxy and failed TLS. You
could not run `cc` and a normal `claude` at the same time. It also required Administrator
/ root (hosts file + privileged port 443) and per-machine certificate trust.

## Current approach (in the top-level project)

`cc` sets `ANTHROPIC_UNIX_SOCKET` to a private per-user socket and `ANTHROPIC_BASE_URL`
to `http://api.anthropic.com`. Claude Code enables Remote Control whenever the socket is
set (the host check is bypassed) and sends all API traffic over that socket to a local
Bun proxy — no hosts file changes, no port 443, no certificates. Plain `claude` never
sets these variables, so it is completely unaffected.

## Files here

| File | What it did |
|------|-------------|
| `hosts-hijack.ps1` / `.sh` | add/remove the `api.anthropic.com → 127.0.0.1` hosts entry |
| `gen-certs.sh` | generate the self-signed CA + `api.anthropic.com` leaf |
| `setup-ca.ps1` / `.sh` | trust a CA bundle via `NODE_EXTRA_CA_CERTS` |
| `test-control-plane.js` | TLS reachability check for the control-plane hosts |
