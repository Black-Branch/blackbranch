'use strict';
// The link gate's baseline: the platforms, plus the install's own domain from settings
// (matrix.serverName) — never a domain written into the code. web's linkGateParity.test.ts
// covers the rest of the policy against the web copy.
// Run: node --test link-gate.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeHost, BASELINE_HOSTS } = require('./link-gate');

test('the install\'s own domain and its subdomains pass only when matrix.serverName names it', () => {
  const saved = process.env.MATRIX_SERVER_NAME;
  try {
    delete process.env.MATRIX_SERVER_NAME;
    assert.equal(judgeHost('example.tv', []), 'unlisted', 'no configured domain = nothing of the site passes on the baseline');
    process.env.MATRIX_SERVER_NAME = 'Example.TV';
    for (const h of ['example.tv', 'api.example.tv', 'matrix.example.tv']) assert.equal(judgeHost(h, []), null, h);
    assert.equal(judgeHost('notexample.tv', []), 'unlisted', 'a suffix that is not a subdomain does not pass');
    assert.equal(judgeHost('bit.ly', []), 'untrustable', 'the configured domain never lifts the untrustable list');
  } finally {
    if (saved === undefined) delete process.env.MATRIX_SERVER_NAME; else process.env.MATRIX_SERVER_NAME = saved;
  }
  assert.ok(BASELINE_HOSTS.includes('twitch.tv') && BASELINE_HOSTS.length >= 5, 'the platform floor is still there');
});
