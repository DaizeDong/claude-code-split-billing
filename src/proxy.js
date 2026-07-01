'use strict';
// Local HTTPS rerouting proxy for Claude Code (MITM-of-api.anthropic.com mode).
//
// Why MITM: current Claude Code gates Remote Control on
//   new URL(process.env.ANTHROPIC_BASE_URL).host === "api.anthropic.com"
// (a pure string check). So to keep RC working AND bill inference to a custom
// gateway, we point the client at https://api.anthropic.com, hijack that host to
// 127.0.0.1 via the system hosts file, and terminate TLS here with a self-signed
// leaf for api.anthropic.com (trusted by Node via NODE_EXTRA_CA_CERTS).
//
//   POST /v1/messages*   -> your inference gateway  (billed there)
//   everything else      -> the REAL api.anthropic.com  (OAuth / Remote Control)
//
// The real upstream is reached by resolving api.anthropic.com via dns.resolve4()
// (which queries real DNS servers and ignores the hosts file), then connecting to
// that IP with SNI/Host = api.anthropic.com — avoiding the self-hijack loop.
//
// All gateway-specific values come from the environment (see .env.example).

const https = require('node:https');
const tls = require('node:tls');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

// --- minimal .env loader (no dependency). Does not override existing env vars. ---
(function loadDotEnv() {
  const envPath = process.env.PROXY_ENV_FILE || path.join(REPO_ROOT, '.env');
  let raw;
  try { raw = fs.readFileSync(envPath, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = Number(process.env.PROXY_PORT || 443);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

// --- Gateway (Anthropic-compatible inference endpoint) ---
const GATEWAY_HOST = process.env.GATEWAY_HOST || '';           // REQUIRED, e.g. gateway.example.com
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 443);
const GATEWAY_BASE_PATH = process.env.GATEWAY_BASE_PATH || ''; // prefix before /v1/messages

function parseJsonEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (e) { throw new Error(`Invalid JSON in ${name}: ${e.message}`); }
}
const GATEWAY_HEADERS = parseJsonEnv('GATEWAY_HEADERS', {});
const GATEWAY_STRIP_HEADERS = (process.env.GATEWAY_STRIP_HEADERS || 'authorization,x-api-key')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const GATEWAY_MODEL_MAP = parseJsonEnv('GATEWAY_MODEL_MAP', {});
const GATEWAY_DEFAULT_MODEL = process.env.GATEWAY_DEFAULT_MODEL || '';

// --- Control plane (OAuth refresh, Remote Control register/poll, feature flags) ---
const CONTROL_HOST = process.env.CONTROL_HOST || 'api.anthropic.com';

// --- TLS material for terminating https://api.anthropic.com locally ---
const CERT_DIR = process.env.PROXY_CERT_DIR || path.join(REPO_ROOT, 'certs');
const KEY_PATH = process.env.PROXY_TLS_KEY || path.join(CERT_DIR, 'server.key');
const CRT_PATH = process.env.PROXY_TLS_CERT || path.join(CERT_DIR, 'server.pem');

if (!GATEWAY_HOST) {
  console.error('FATAL: GATEWAY_HOST is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
let TLS_KEY, TLS_CERT;
try {
  TLS_KEY = fs.readFileSync(KEY_PATH);
  TLS_CERT = fs.readFileSync(CRT_PATH);
} catch (e) {
  console.error(`FATAL: cannot read TLS cert/key (${KEY_PATH}, ${CRT_PATH}).`);
  console.error('Run scripts/gen-certs.sh first.');
  process.exit(1);
}

const LOG_FILE = process.env.PROXY_LOG || path.join(REPO_ROOT, 'proxy.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

function mapModel(model) {
  if (typeof model !== 'string') return GATEWAY_DEFAULT_MODEL || model;
  const m = model.toLowerCase();
  for (const key of Object.keys(GATEWAY_MODEL_MAP)) {
    if (m.includes(key.toLowerCase())) return GATEWAY_MODEL_MAP[key];
  }
  return model;
}

function isInferencePath(p) {
  return p === '/v1/messages' || p.startsWith('/v1/messages');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Resolve the REAL api.anthropic.com IP, bypassing the hosts hijack. ---
// dns.resolve4 queries configured DNS servers directly and ignores the hosts file
// (unlike dns.lookup). Cached with a short TTL; falls back to the last good IP.
let ipCache = { ip: null, at: 0 };
const IP_TTL_MS = 60_000;
function resolveControlIp() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (ipCache.ip && now - ipCache.at < IP_TTL_MS) return resolve(ipCache.ip);
    dns.resolve4(CONTROL_HOST, (e, addrs) => {
      if (!e && addrs && addrs.length) {
        ipCache = { ip: addrs[0], at: now };
        return resolve(addrs[0]);
      }
      if (ipCache.ip) return resolve(ipCache.ip); // stale but usable
      reject(e || new Error('no A record for ' + CONTROL_HOST));
    });
  });
}

const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, async (req, res) => {
  // Local reachability probe (HEAD/GET /). Answer locally.
  if ((req.method === 'HEAD' || req.method === 'GET') && (req.url === '/' || req.url === '')) {
    log('PROBE', req.method, req.url, '-> 200 (local)');
    res.writeHead(200); res.end(); return;
  }

  let bodyBuf;
  try { bodyBuf = await readBody(req); }
  catch (e) { log('ERR reading body', req.method, req.url, String(e)); res.writeHead(400); res.end('bad request body'); return; }

  const toGateway = req.method === 'POST' && isInferencePath(req.url);

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length'];
  delete headers['accept-encoding'];

  let opts, upstreamLabel, modelNote = '';

  if (toGateway) {
    for (const h of GATEWAY_STRIP_HEADERS) delete headers[h];
    for (const [k, v] of Object.entries(GATEWAY_HEADERS)) headers[k.toLowerCase()] = v;
    headers['host'] = GATEWAY_HOST;

    try {
      const json = JSON.parse(bodyBuf.toString('utf8'));
      if (json && typeof json === 'object' && 'model' in json) {
        const orig = json.model, mapped = mapModel(orig);
        if (mapped !== orig) { json.model = mapped; modelNote = `model ${orig} -> ${mapped}`; bodyBuf = Buffer.from(JSON.stringify(json), 'utf8'); }
      }
    } catch { /* not JSON */ }

    if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);
    opts = { host: GATEWAY_HOST, port: GATEWAY_PORT, method: req.method, path: GATEWAY_BASE_PATH + req.url, headers };
    upstreamLabel = GATEWAY_HOST + GATEWAY_BASE_PATH + req.url;
    forward(opts, bodyBuf, req, res, upstreamLabel, modelNote);
  } else {
    // Control plane -> REAL api.anthropic.com (via resolved IP + SNI).
    headers['host'] = CONTROL_HOST;
    if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);
    let ip;
    try { ip = await resolveControlIp(); }
    catch (e) { log('ERR resolve', CONTROL_HOST, String(e)); res.writeHead(502); res.end('dns error'); return; }
    opts = { host: ip, port: 443, servername: CONTROL_HOST, method: req.method, path: req.url, headers };
    upstreamLabel = CONTROL_HOST + req.url + ` (${ip})`;
    forward(opts, bodyBuf, req, res, upstreamLabel, '');
  }
});

function forward(opts, bodyBuf, req, res, label, modelNote) {
  log('REQ', req.method, req.url, '->', label, modelNote);
  const upstream = https.request(opts, (ur) => {
    const outHeaders = { ...ur.headers };
    delete outHeaders['transfer-encoding'];
    delete outHeaders['connection'];
    res.writeHead(ur.statusCode || 502, outHeaders);
    ur.pipe(res);
    log('RES', ur.statusCode, 'from', label);
  });
  upstream.on('error', (e) => {
    log('ERR upstream', label, String(e));
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error: ' + String(e));
  });
  if (bodyBuf && bodyBuf.length) upstream.write(bodyBuf);
  upstream.end();
}

// --- WebSocket / Upgrade tunneling for the control plane (RC bridge, etc.). ---
// Inference never upgrades, so all upgrades go to the real control host.
server.on('upgrade', async (req, socket, head) => {
  let ip;
  try { ip = await resolveControlIp(); }
  catch (e) { log('ERR upgrade resolve', String(e)); socket.destroy(); return; }
  log('UPGRADE', req.url, '->', CONTROL_HOST, `(${ip})`);
  const up = tls.connect({ host: ip, port: 443, servername: CONTROL_HOST }, () => {
    let reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    const h = { ...req.headers, host: CONTROL_HOST };
    for (const [k, v] of Object.entries(h)) {
      if (Array.isArray(v)) { for (const vv of v) reqLine += `${k}: ${vv}\r\n`; }
      else reqLine += `${k}: ${v}\r\n`;
    }
    reqLine += '\r\n';
    up.write(reqLine);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on('error', (e) => { log('ERR upgrade upstream', String(e)); socket.destroy(); });
  socket.on('error', () => up.destroy());
});

server.listen(PORT, HOST, () => {
  log(`HTTPS proxy listening on https://${HOST}:${PORT}  (terminating ${CONTROL_HOST})`);
  log(`inference -> https://${GATEWAY_HOST}${GATEWAY_BASE_PATH}/v1/messages  (billed to your gateway)`);
  log(`control   -> https://${CONTROL_HOST}  (real, via resolved IP; OAuth / Remote Control)`);
});
