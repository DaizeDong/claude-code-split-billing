'use strict';
// Local rerouting proxy for Claude Code — AF_UNIX socket mode (Bun).
//
// Why a unix socket (and why Bun): current Claude Code enables Remote Control when
//   isFirstParty && (process.env.ANTHROPIC_UNIX_SOCKET is set || baseURL host === "api.anthropic.com")
// and, when ANTHROPIC_UNIX_SOCKET is set, sends ALL API traffic over that socket via
// Bun's `fetch(url, { unix })`. On Windows that unix option is an AF_UNIX filesystem
// socket, which Node cannot serve — so this proxy runs under Bun (`Bun.serve({ unix })`).
//
// Pointing cc at a socket means NO system hosts hijack, NO privileged port 443, and NO
// self-signed CA: plain `claude` (which never sets ANTHROPIC_UNIX_SOCKET) is completely
// unaffected. That is the isolation cc gives you.
//
//   POST /v1/messages*  -> your inference gateway         (billed there)
//   everything else     -> the real https://api.anthropic.com  (OAuth / Remote Control)
//
// In socket mode Claude Code does not attach its own auth ("the local proxy is
// API-key-authed"): this proxy injects gateway credentials for inference and the
// user's OAuth bearer for the control plane. The bearer is read fresh from the config
// dir's .credentials.json (so token refreshes done by Claude are picked up).
//
// All gateway-specific values come from the environment (see .env.example).

const fs = require('node:fs');
const os = require('node:os');
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

if (typeof Bun === 'undefined') {
  console.error('FATAL: proxy.js must be run with Bun (Node cannot serve an AF_UNIX socket on Windows).');
  console.error('Install Bun:  npm i -g bun    (or see https://bun.sh)  then relaunch cc.');
  process.exit(1);
}

// --- socket the proxy listens on (must match what cc exports as ANTHROPIC_UNIX_SOCKET) ---
const SOCK = process.env.CC_SOCK || process.env.ANTHROPIC_UNIX_SOCKET;
if (!SOCK) { console.error('FATAL: CC_SOCK / ANTHROPIC_UNIX_SOCKET not set.'); process.exit(1); }

// --- Gateway (Anthropic-compatible inference endpoint) ---
const GATEWAY_HOST = process.env.GATEWAY_HOST || '';
const GATEWAY_PORT = process.env.GATEWAY_PORT || '';
const GATEWAY_BASE_PATH = process.env.GATEWAY_BASE_PATH || '';
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

// --- Control plane (real Anthropic; OAuth refresh, Remote Control register/poll) ---
const CONTROL_HOST = process.env.CONTROL_HOST || 'api.anthropic.com';
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

if (!GATEWAY_HOST) {
  console.error('FATAL: GATEWAY_HOST is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const LOG_FILE = process.env.PROXY_LOG || path.join(REPO_ROOT, 'proxy.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

// --- OAuth bearer for the control plane, read fresh (5s cache) from .credentials.json ---
// Claude Code refreshes this file itself; re-reading keeps us on the current access token.
let bearerCache = { token: null, at: 0 };
function getOAuthBearer() {
  const now = Date.now();
  if (bearerCache.token && now - bearerCache.at < 5000) return bearerCache.token;
  let token = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, '.credentials.json'), 'utf8'));
    token = j?.claudeAiOauth?.accessToken || null;
  } catch { /* file-based creds absent (e.g. macOS keychain); rely on env fallback */ }
  if (!token) token = process.env.PROXY_OAUTH_BEARER || null;
  bearerCache = { token, at: now };
  return token;
}

function mapModel(model) {
  if (typeof model !== 'string') return GATEWAY_DEFAULT_MODEL || model;
  const m = model.toLowerCase();
  for (const key of Object.keys(GATEWAY_MODEL_MAP)) {
    if (m.includes(key.toLowerCase())) return GATEWAY_MODEL_MAP[key];
  }
  return model;
}

function isInferencePath(p) { return p === '/v1/messages' || p.startsWith('/v1/messages'); }

function scrubHeaders(h) {
  const out = {};
  for (const [k, v] of h) out[k] = v;
  delete out['host']; delete out['content-length']; delete out['accept-encoding']; delete out['connection'];
  return out;
}

Bun.serve({
  unix: SOCK,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const pathq = url.pathname + url.search;

    // liveness probe used by ensure-proxy.js
    if (url.pathname === '/__cc_ping') return new Response('cc-proxy', { status: 200 });

    const toGateway = req.method === 'POST' && isInferencePath(url.pathname);
    let bodyBuf;
    if (req.body) { try { bodyBuf = Buffer.from(await req.arrayBuffer()); } catch { bodyBuf = undefined; } }

    const headers = scrubHeaders(req.headers);
    let target, label, note = '';

    if (toGateway) {
      for (const h of GATEWAY_STRIP_HEADERS) delete headers[h];
      for (const [k, v] of Object.entries(GATEWAY_HEADERS)) headers[k.toLowerCase()] = v;
      if (bodyBuf) {
        try {
          const j = JSON.parse(bodyBuf.toString('utf8'));
          if (j && typeof j === 'object' && 'model' in j) {
            const mapped = mapModel(j.model);
            if (mapped !== j.model) { note = `model ${j.model} -> ${mapped}`; j.model = mapped; bodyBuf = Buffer.from(JSON.stringify(j), 'utf8'); }
          }
        } catch { /* not JSON */ }
      }
      const portSeg = GATEWAY_PORT && GATEWAY_PORT !== '443' ? `:${GATEWAY_PORT}` : '';
      target = `https://${GATEWAY_HOST}${portSeg}${GATEWAY_BASE_PATH}${pathq}`;
      label = 'INFER';
    } else {
      // control plane -> real Anthropic; inject OAuth bearer if the client sent none
      if (!headers['authorization']) {
        const bearer = getOAuthBearer();
        if (bearer) headers['authorization'] = 'Bearer ' + bearer;
      }
      target = `https://${CONTROL_HOST}${pathq}`;
      label = 'CTRL';
    }

    log('REQ', req.method, url.pathname, '->', label, note);
    try {
      const r = await fetch(target, { method: req.method, headers, body: bodyBuf });
      log('RES', r.status, label, url.pathname);
      const outH = new Headers(r.headers);
      outH.delete('content-encoding'); outH.delete('content-length'); outH.delete('transfer-encoding');
      return new Response(r.body, { status: r.status, headers: outH });
    } catch (e) {
      log('ERR', label, url.pathname, String(e));
      return new Response('proxy upstream error: ' + String(e), { status: 502 });
    }
  },
  error(e) { log('SERVER ERROR', String(e)); return new Response('proxy error', { status: 500 }); },
});

log(`unix proxy listening on ${SOCK}`);
log(`inference -> https://${GATEWAY_HOST}${GATEWAY_BASE_PATH}/v1/messages  (billed to your gateway)`);
log(`control   -> https://${CONTROL_HOST}  (real; OAuth / Remote Control)`);
console.log(`cc proxy listening on ${SOCK}`);
