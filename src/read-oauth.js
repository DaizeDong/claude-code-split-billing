'use strict';
// Print a field of the current Claude Code OAuth credentials to stdout, nothing else,
// so cc can capture it into an env var without echoing it. Runs under Bun.
//
//   bun read-oauth.js            -> prints claudeAiOauth.accessToken
//   bun read-oauth.js scopes     -> prints claudeAiOauth.scopes
//
// Reads $CLAUDE_CONFIG_DIR/.credentials.json (Windows/Linux). On macOS, where creds
// live in the Keychain, falls back to `security find-generic-password` (best effort).
// Prints an empty string (exit 0) if nothing is found, so cc can give a clean hint.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const field = (process.argv[2] || 'accessToken');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function fromFile() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, '.credentials.json'), 'utf8'));
    return j?.claudeAiOauth || null;
  } catch { return null; }
}

function fromKeychain() {
  if (process.platform !== 'darwin') return null;
  for (const service of ['Claude Code-credentials', 'Claude Code']) {
    try {
      const p = Bun.spawnSync(['security', 'find-generic-password', '-s', service, '-w']);
      if (p.exitCode === 0) {
        const raw = p.stdout.toString().trim();
        const j = JSON.parse(raw);
        if (j?.claudeAiOauth) return j.claudeAiOauth;
      }
    } catch { /* try next */ }
  }
  return null;
}

const oauth = fromFile() || fromKeychain();
let val = '';
if (oauth) {
  if (field === 'scopes') val = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : (oauth.scopes || '');
  else val = oauth[field] || '';
}
process.stdout.write(val);
