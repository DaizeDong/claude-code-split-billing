'use strict';
// Start the rerouting proxy if it isn't already listening.
// Exits quickly either way so the wrapper can proceed to launch claude. Idempotent.

const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = Number(process.env.PROXY_PORT || 8787);
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
  setTimeout(() => process.exit(0), 600); // give it a moment to bind
};

sock.on('timeout', () => { sock.destroy(); startProxy(); });
sock.on('error', () => { startProxy(); });
