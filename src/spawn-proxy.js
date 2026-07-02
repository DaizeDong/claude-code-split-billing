'use strict';
// Tiny Node shim: launch the Bun proxy as a fully DETACHED background process that
// survives its parent. Bun.spawn + unref does not detach on Windows, but Node's
// spawn({detached:true, windowsHide:true}) does — so ensure-proxy.js (Bun) calls this.
//
//   node spawn-proxy.js <path-to-bun-executable>
//
// The Bun executable path is passed in (ensure-proxy passes its own process.execPath,
// which is bun.exe) so we don't have to resolve `bun` from PATH here.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const bun = process.argv[2] || process.env.CC_BUN || 'bun';
const PROXY_JS = path.join(__dirname, 'proxy.js');
const logfd = fs.openSync(path.join(__dirname, '..', 'proxy-stdout.log'), 'a');

const child = spawn(bun, [PROXY_JS], {
  detached: true,
  stdio: ['ignore', logfd, logfd],
  windowsHide: true,
  env: process.env,
});
child.unref();
