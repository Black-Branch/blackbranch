'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listenAddress } = require('./listen-address');

test('unset → the defaults production has always used', () => {
  assert.deepEqual(listenAddress({}), { port: 3001, host: '0.0.0.0', error: null });
  assert.deepEqual(listenAddress({ STREAM_API_PORT: '', STREAM_API_HOST: '  ' }), { port: 3001, host: '0.0.0.0', error: null });
});

test('an install picks its own port and bind address', () => {
  assert.deepEqual(listenAddress({ STREAM_API_PORT: '3101', STREAM_API_HOST: '127.0.0.1' }), { port: 3101, host: '127.0.0.1', error: null });
});

test('a malformed port is an error, not a fallback to the default', () => {
  for (const bad of ['31o1', '0', '70000', '-1', '3101.5', '3101 ']) {
    const r = listenAddress({ STREAM_API_PORT: bad });
    if (bad === '3101 ') { assert.equal(r.port, 3101); continue; } // surrounding space is trimmed
    assert.match(r.error, /STREAM_API_PORT/, bad);
    assert.equal(r.port, undefined, bad);
  }
});
