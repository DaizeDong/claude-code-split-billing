'use strict';
// Start the rerouting proxy if it isn't already listening.
// Exits quickly either way so the wrapper can proceed to launch claude. Idempotent.

const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = Number(process.env.PROXY_PORT || 443);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const REPO_ROOT = path.join(__dirname, '..');

const sock = net.connect({ host: HOST, port: PORT });
sock.setTimeout(800);
sock.on('connect', () => { sock.destroy(); process.exit(0); }); // already running

const startProxy = () => {
  const logfd = fs.openSync(path.join(REPO_ROOT, 'proxy-stdout.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'proxy.js')], {
    detached: true,
    stdio: ['ignore', logfd, logfd],
    windowsHide: true,
  });
  child.unref();
  // Verify it actually bound. On macOS/Linux, port 443 is privileged and the spawn
  // may die immediately with EACCES — catch that here instead of launching claude
  // against a dead proxy.
  setTimeout(() => {
    const check = net.connect({ host: HOST, port: PORT });
    check.setTimeout(600);
    const fail = () => {
      check.destroy();
      console.error(`ensure-proxy: proxy did not come up on ${HOST}:${PORT}.`);
      if (process.platform !== 'win32' && PORT < 1024) {
        console.error('Port 443 is privileged on macOS/Linux — see README "Port 443 on macOS/Linux".');
      }
      console.error('See proxy-stdout.log for the underlying error.');
      process.exit(1);
    };
    check.on('connect', () => { check.destroy(); process.exit(0); });
    check.on('timeout', fail);
    check.on('error', fail);
  }, 700);
};

sock.on('timeout', () => { sock.destroy(); startProxy(); });
sock.on('error', () => { startProxy(); });
