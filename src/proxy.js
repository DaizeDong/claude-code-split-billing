'use strict';
// Local rerouting proxy for Claude Code.
//
// Goal: a single OAuth-logged-in Claude Code session keeps Remote Control working
// (the control plane keeps talking to Anthropic directly), while LLM inference
// (POST /v1/messages*) is rerouted to a custom, Anthropic-compatible gateway so
// that token usage is billed to that gateway instead of your subscription quota.
//
// Run:    node src/proxy.js
// Point Claude Code at it:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787  (no ANTHROPIC_API_KEY)
//
// All gateway-specific values come from the environment (see .env.example).
// Nothing secret is hardcoded in this file.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

// --- minimal .env loader (no dependency). Loads <repo>/.env if present. ---
// Does not override variables that are already set in the environment.
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

const PORT = Number(process.env.PROXY_PORT || 8787);
const HOST = process.env.PROXY_HOST || '127.0.0.1';

// --- Gateway (Anthropic-compatible inference endpoint) ---
const GATEWAY_HOST = process.env.GATEWAY_HOST || '';          // e.g. gateway.example.com  (REQUIRED)
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 443);
const GATEWAY_BASE_PATH = process.env.GATEWAY_BASE_PATH || ''; // prefix prepended before /v1/messages, e.g. /v1-prefix

// Headers to inject on inference requests (auth, tenant id, etc.) as a JSON object.
// e.g. GATEWAY_HEADERS={"Authorization":"Bearer xxx"}  or  {"X-Api-Key":"...","X-User":"..."}
function parseJsonEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  try { return JSON.parse(v); } catch (e) {
    throw new Error(`Invalid JSON in ${name}: ${e.message}`);
  }
}
const GATEWAY_HEADERS = parseJsonEnv('GATEWAY_HEADERS', {});

// Client headers to strip before forwarding inference upstream (so the client's
// OAuth token is not leaked to the gateway). Comma-separated, case-insensitive.
const GATEWAY_STRIP_HEADERS = (process.env.GATEWAY_STRIP_HEADERS || 'authorization,x-api-key')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Optional model remapping. JSON of { "<substring>": "<replacement model id>" }.
// The incoming model id is lowercased; the first key that is a substring of it
// causes the whole model id to be replaced. If empty/unset, the model passes through.
// e.g. GATEWAY_MODEL_MAP={"haiku":"my-haiku","sonnet":"my-sonnet","opus":"my-opus"}
const GATEWAY_MODEL_MAP = parseJsonEnv('GATEWAY_MODEL_MAP', {});
const GATEWAY_DEFAULT_MODEL = process.env.GATEWAY_DEFAULT_MODEL || ''; // used only if model is missing/non-string

// --- Control plane (OAuth refresh, remote-control registration/polling, feature flags) ---
const CONTROL_HOST = process.env.CONTROL_HOST || 'api.anthropic.com';

if (!GATEWAY_HOST) {
  // eslint-disable-next-line no-console
  console.error('FATAL: GATEWAY_HOST is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const LOG_FILE = process.env.PROXY_LOG || path.join(REPO_ROOT, 'proxy.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ');
  // eslint-disable-next-line no-console
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* ignore */ }
}

function mapModel(model) {
  if (typeof model !== 'string') return GATEWAY_DEFAULT_MODEL || model;
  const m = model.toLowerCase();
  for (const key of Object.keys(GATEWAY_MODEL_MAP)) {
    if (m.includes(key.toLowerCase())) return GATEWAY_MODEL_MAP[key];
  }
  return model; // pass through unchanged
}

function isInferencePath(p) {
  return p === '/v1/messages' || p.startsWith('/v1/messages'); // includes /v1/messages/count_tokens
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Base-URL reachability probe from Claude Code (HEAD/GET on "/"). Answer locally;
  // forwarding it upstream is pointless and may fail behind a TLS-intercepting proxy.
  if ((req.method === 'HEAD' || req.method === 'GET') && (req.url === '/' || req.url === '')) {
    log('PROBE', req.method, req.url, '-> 200 (local)');
    res.writeHead(200); res.end(); return;
  }

  let bodyBuf;
  try {
    bodyBuf = await readBody(req);
  } catch (e) {
    log('ERR reading body', req.method, req.url, String(e));
    res.writeHead(400); res.end('bad request body'); return;
  }

  const toGateway = req.method === 'POST' && isInferencePath(req.url);

  // Build upstream headers from incoming, then adjust.
  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['content-length']; // recompute after any body rewrite
  delete headers['accept-encoding']; // avoid compressed upstream responses we'd have to handle

  let upstreamHost, upstreamPort, upstreamPath, modelNote = '';

  if (toGateway) {
    upstreamHost = GATEWAY_HOST;
    upstreamPort = GATEWAY_PORT;
    upstreamPath = GATEWAY_BASE_PATH + req.url; // e.g. /prefix/v1/messages...

    // strip the client's auth headers, inject the gateway's
    for (const h of GATEWAY_STRIP_HEADERS) delete headers[h];
    for (const [k, v] of Object.entries(GATEWAY_HEADERS)) headers[k.toLowerCase()] = v;
    headers['host'] = GATEWAY_HOST;

    // optionally rewrite the model id in the JSON body
    try {
      const json = JSON.parse(bodyBuf.toString('utf8'));
      if (json && typeof json === 'object' && 'model' in json) {
        const orig = json.model;
        const mapped = mapModel(orig);
        if (mapped !== orig) {
          json.model = mapped;
          modelNote = `model ${orig} -> ${mapped}`;
          bodyBuf = Buffer.from(JSON.stringify(json), 'utf8');
        }
      }
    } catch {
      // not JSON — forward as-is
    }
  } else {
    upstreamHost = CONTROL_HOST;
    upstreamPort = 443;
    upstreamPath = req.url;
    headers['host'] = CONTROL_HOST;
  }

  if (bodyBuf && bodyBuf.length) headers['content-length'] = String(bodyBuf.length);

  log('REQ', req.method, req.url, '->', upstreamHost + upstreamPath, modelNote);

  const opts = { host: upstreamHost, port: upstreamPort, method: req.method, path: upstreamPath, headers };
  const upstream = https.request(opts, (ur) => {
    const outHeaders = { ...ur.headers };
    delete outHeaders['transfer-encoding'];
    delete outHeaders['connection'];
    res.writeHead(ur.statusCode || 502, outHeaders);
    ur.pipe(res);
    log('RES', ur.statusCode, 'from', upstreamHost + upstreamPath);
  });
  upstream.on('error', (e) => {
    log('ERR upstream', upstreamHost + upstreamPath, String(e));
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error: ' + String(e));
  });
  if (bodyBuf && bodyBuf.length) upstream.write(bodyBuf);
  upstream.end();
});

server.listen(PORT, HOST, () => {
  log(`proxy listening on http://${HOST}:${PORT}`);
  log(`inference -> https://${GATEWAY_HOST}${GATEWAY_BASE_PATH}/v1/messages  (billed to your gateway)`);
  log(`control   -> https://${CONTROL_HOST}  (OAuth / remote-control)`);
});
