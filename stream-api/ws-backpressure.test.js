// Outbound backpressure on the WS hub.
//
// A heartbeat sweep alone reaps only clients that stop PONGING. A client that
// keeps answering pings but stops READING — a wedged tab, a throttled mobile
// radio, a deliberately slow socket — passes every heartbeat while every
// broadcast() accumulates in its `bufferedAmount` without bound. One such
// client grows server memory for as long as the stream runs, and nothing logs.
//
// So the sweep has a per-client verdict: over the buffered cap →
// terminate, regardless of pong liveness. The decision is exported pure
// (`sweepVerdict`) so it can be tested without a live server; the wiring scan
// below pins that the interval actually applies it.
//
// Run: node --test ws-backpressure.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { sweepVerdict } = require('./ws-hub.js');

test('sweepVerdict is exported', () => {
  assert.equal(typeof sweepVerdict, 'function',
    'ws-hub.js must export sweepVerdict — the heartbeat decision is untestable while inlined');
});

test('a dead client (no pong) is terminated, as before', () => {
  assert.equal(sweepVerdict({ isAlive: false, bufferedAmount: 0 }, 1024), 'dead');
});

test('a slow-reading-but-ponging client over the cap is terminated', () => {
  // isAlive: true is the point — this client answers every ping. Before this
  // fix it survived the sweep forever while its buffer grew.
  assert.equal(sweepVerdict({ isAlive: true, bufferedAmount: 1025 }, 1024), 'backpressure');
});

test('a client AT the cap is pinged, not terminated (cap is exclusive)', () => {
  assert.equal(sweepVerdict({ isAlive: true, bufferedAmount: 1024 }, 1024), 'ping');
});

test('a healthy client is pinged', () => {
  assert.equal(sweepVerdict({ isAlive: true, bufferedAmount: 0 }, 1024), 'ping');
});

test('dead wins over backpressure — a corpse is reported as a corpse', () => {
  // A client that stopped ponging also stopped reading, so its buffer is high
  // too. Reporting it as backpressure would make every ordinary zombie look
  // like the new failure mode in the logs.
  assert.equal(sweepVerdict({ isAlive: false, bufferedAmount: 99999 }, 1024), 'dead');
});

// ── Wiring: the sweep actually applies the verdict ──────────────────────────
// Comment-stripped source scan (same shape as shutdown.test.js — line comments
// first, then blocks), with the vacuity anchor on the file's LAST statement.

const src = readFileSync(join(__dirname, 'ws-hub.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the scan sees the whole of ws-hub.js, tail included', () => {
  assert.match(src, /module\.exports = \{ createWsHub/,
    'the scan lost the END of ws-hub.js — every wiring assertion below is checking a truncated file');
});

test('the heartbeat interval consults sweepVerdict and terminates on it', () => {
  const sweep = src.slice(src.indexOf('setInterval'));
  assert.match(sweep, /sweepVerdict\s*\(/,
    'the heartbeat sweep no longer calls sweepVerdict — the pure decision above is tested but unwired');
  assert.match(sweep, /terminate\(\)/,
    'the sweep never terminates — verdicts without consequences reap nothing');
});

test('the buffered cap is env-overridable like the other two WS caps', () => {
  assert.match(src, /WS_MAX_BUFFERED/,
    'WS_MAX_BUFFERED is gone — the cap must be tunable without a code deploy, like WS_MAX_PAYLOAD/MAX_WS_CLIENTS');
});
