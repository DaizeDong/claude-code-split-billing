'use strict';
// Ensure the cc rerouting proxy is up on the AF_UNIX socket. Idempotent; runs under Bun.
// Pings the socket; if nothing answers, clears a stale socket file, spawns proxy.js
// detached, and polls until it responds (or fails fast). cc runs this before launching claude.

const fs = require('node:fs');
const path = require('node:path');

if (typeof Bun === 'undefined') {
  console.error('ensure-proxy: must run under Bun (npm i -g bun).');
  process.exit(1);
}

const SOCK = process.env.CC_SOCK || process.env.ANTHROPIC_UNIX_SOCKET;
if (!SOCK) { console.error('ensure-proxy: CC_SOCK / ANTHROPIC_UNIX_SOCKET not set.'); process.exit(1); }

async function ping(timeoutMs) {
  try {
    const r = await fetch('http://localhost/__cc_ping', { unix: SOCK, signal: AbortSignal.timeout(timeoutMs) });
    return r.status === 200;
  } catch { return false; }
}

(async () => {
  if (await ping(800)) process.exit(0); // already running

  // Nothing answered. Remove a stale socket file so Bun.serve can bind (Bun does not
  // auto-unlink; a leftover file from a dead proxy would otherwise cause EADDRINUSE).
  try { fs.rmSync(SOCK, { force: true }); } catch { /* ignore */ }

  // Launch the proxy fully detached. Bun.spawn+unref does NOT survive parent exit on
  // Windows, so we hand off to a tiny Node shim (Node's detached spawn does survive).
  // process.execPath is bun.exe — pass it so the shim runs the proxy under Bun.
  const node = process.env.CC_NODE || 'node';
  Bun.spawnSync({
    cmd: [node, path.join(__dirname, 'spawn-proxy.js'), process.execPath],
    stdin: 'ignore', stdout: 'ignore', stderr: 'inherit',
    env: process.env,
  });

  for (let i = 0; i < 25; i++) {           // up to ~5s
    await Bun.sleep(200);
    if (await ping(500)) process.exit(0);
  }
  console.error('ensure-proxy: proxy did not come up on ' + SOCK + ' — see proxy-stdout.log / proxy.log');
  process.exit(1);
})();
