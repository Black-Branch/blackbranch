// The `history` frame is serialized once per buffer CHANGE, not once per
// connection.
//
// Stringifying the full 200-message buffer (hundreds of KB during a busy
// stream) on every connect makes a reconnect storm (stream start, a wifi blip,
// an OBS overlay reload) pay it once per socket, on the box that serves live
// chat.
//
// The invalidation set is the whole point, and redactBuffered is its
// security edge: redaction exists precisely because the buffer is replayed to
// every future connection — a redacted slur served from a STALE cached string
// would undo the redaction (a mod deletes it, every reconnecting viewer still
// receives it). Miss that invalidation and the
// optimization is a moderation regression.
//
// The cache is exported pure (makeHistoryCache) for behavior; the wiring scan
// pins that all three buffer mutators invalidate and the connect path serves
// the cache. Same trade as ws-backpressure.test.js.
//
// Run: node --test ws-history-cache.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { makeHistoryCache } = require('./ws-hub.js');

test('the cache serializes the live buffer', () => {
  const buf = [{ id: 1, message: 'hi' }];
  const cache = makeHistoryCache(buf);
  assert.deepEqual(JSON.parse(cache.get()), { type: 'history', messages: [{ id: 1, message: 'hi' }] });
});

test('without invalidation the cache is genuinely a cache (stale on silent mutation)', () => {
  // This is the property that makes the optimization real: get() must NOT
  // re-serialize per call. A mutation that skips invalidate() is served stale
  // — which is why the wiring scan below pins every mutator.
  const buf = [{ id: 1, message: 'hi' }];
  const cache = makeHistoryCache(buf);
  const before = cache.get();
  buf.push({ id: 2, message: 'new' });
  assert.equal(cache.get(), before, 'get() re-serialized — every connect still pays the full stringify');
});

test('invalidate() makes the next get() reflect the buffer — the redaction case', () => {
  const buf = [{ id: 1, message: 'a slur' }];
  const cache = makeHistoryCache(buf);
  cache.get();
  buf[0].message = '';
  buf[0].deleted = true;
  cache.invalidate();
  const replayed = JSON.parse(cache.get());
  assert.equal(replayed.messages[0].message, '',
    'a redacted message is still replayed from the stale cache — the moderation bug is back');
  assert.equal(replayed.messages[0].deleted, true);
});

// ── Wiring: every buffer mutator invalidates; connect serves the cache ──────
// Comment-stripped scan, vacuity anchor on the file's last statement.

const src = readFileSync(join(__dirname, 'ws-hub.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('all three buffer mutators invalidate, and connect sends the cached string', () => {
  for (const fn of ['bufferPush', 'bufferReplace', 'redactBuffered']) {
    const body = src.slice(src.indexOf(`function ${fn}(`), src.indexOf('\n  }', src.indexOf(`function ${fn}(`)));
    assert.ok(body.length > 0, `vacuity anchor: ${fn} is gone from ws-hub.js`);
    assert.match(body, /history\.invalidate\(\)/,
      `${fn} mutates the buffer without invalidating — connects replay a stale history`);
  }
  assert.match(src, /ws\.send\(history\.get\(ws\.internal\)\)/,
    'the connect path is not serving the cached history frame');
  assert.match(src, /module\.exports = \{ createWsHub, sweepVerdict, makeHistoryCache, bucketOf, isLocalDirect \}/,
    'vacuity anchor: the export line changed — update this scan');
});
