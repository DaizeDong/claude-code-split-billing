'use strict';
// Quick TLS connectivity test to Claude Code's control-plane hosts.
// Exits 0 if all hosts are reachable over TLS, 1 otherwise.
// Usage: node scripts/test-control-plane.js [host ...]
// Honors NODE_EXTRA_CA_CERTS, so run it after exporting a corporate CA bundle.

const https = require('node:https');

const hosts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['api.anthropic.com', 'mcp-proxy.anthropic.com', 'claude.ai'];

let pending = hosts.length;
let failures = 0;

for (const h of hosts) {
  https
    .get({ host: h, path: '/', timeout: 8000 }, (r) => {
      console.log(h, 'OK status', r.statusCode);
      r.destroy();
      if (--pending === 0) finish();
    })
    .on('error', (e) => {
      console.log(h, 'ERR', e.message);
      failures++;
      if (--pending === 0) finish();
    });
}

function finish() {
  if (failures) {
    console.log('\nSome hosts failed. If the error is "unable to get local issuer certificate",');
    console.log('your network is doing TLS interception and Node does not trust the root CA yet.');
    console.log('Export the corporate root CA to ca-bundle.pem (see scripts/setup-ca.*).');
  } else {
    console.log('\nAll control-plane hosts reachable (any 2xx/3xx/4xx status counts).');
  }
  process.exit(failures ? 1 : 0);
}
