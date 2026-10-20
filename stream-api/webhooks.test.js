// Unit tests for the webhook hardening in webhooks.js — constant-time compare
// and the replay/idempotency guard. Run: node --test webhooks.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeEqual, createSeenStore } = require('./webhooks');

test('safeEqual: equal strings match', () => {
  assert.equal(safeEqual('s3cr3t-token', 's3cr3t-token'), true);
});

test('safeEqual: different strings do not match', () => {
  assert.equal(safeEqual('s3cr3t-token', 's3cr3t-tokeX'), false);
});

test('safeEqual: unequal-length strings do not match (and do not throw)', () => {
  assert.equal(safeEqual('short', 'a-much-longer-value'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('safeEqual: coerces non-strings without throwing', () => {
  assert.equal(safeEqual(undefined, 'x'), false);   // 'undefined' !== 'x'
  assert.equal(safeEqual(null, 'null'), true);       // String(null) === 'null'
});

test('replay guard: first sighting passes, exact replay is caught', () => {
  const s = createSeenStore();
  assert.equal(s.isDuplicate('kofi:tx-1'), false); // first
  assert.equal(s.isDuplicate('kofi:tx-1'), true);  // replay
  assert.equal(s.isDuplicate('kofi:tx-2'), false); // distinct id
});

test('replay guard: falsy id is never deduped (fail-open on missing id)', () => {
  const s = createSeenStore();
  assert.equal(s.isDuplicate(''), false);
  assert.equal(s.isDuplicate(''), false);
  assert.equal(s.isDuplicate(undefined), false);
});

test('replay guard: id is forgotten after its TTL', async () => {
  const s = createSeenStore({ ttlMs: 20 });
  assert.equal(s.isDuplicate('x'), false);
  assert.equal(s.isDuplicate('x'), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.isDuplicate('x'), false); // TTL expired → treated as new
});

// ── wiring guard: the urlencoded parser stays SCOPED to the Ko-fi webhook ────
// Ko-fi is the only form-encoded caller. A global express.urlencoded() is a
// CSRF surface: a browser running ON an internal host is
// 127.0.0.1 to requireInternal, and a hostile page can fire form-encoded
// POSTs without a CORS preflight — scoping the parser means those bodies
// never parse on any internal route. app.use is invisible to the
// route-surface snapshot, so this source anchor is the guard.
test('index.js scopes urlencoded to /webhook/kofi and never re-globalizes it', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  // Line comments are stripped BEFORE block comments, and the order is
  // load-bearing. index.js documents the money routes as `/timer/` + a star
  // inside a `//` comment; to a block-comment regex that is an opener, so
  // stripping blocks first silently deletes everything up to the next
  // terminator below it. This assertion is a doesNotMatch, so a truncated
  // middle makes it pass VACUOUSLY: the CSRF surface it guards could reopen
  // anywhere in the deleted region and this test would stay green.
  const src = readFileSync(join(__dirname, 'index.js'), 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(src, /unhandledRejection/,
    'the scan lost the tail of index.js — the comment strip truncated it, and the ' +
    'doesNotMatch below is now vacuous over whatever was dropped');
  assert.match(src, /app\.use\('\/webhook\/kofi', express\.urlencoded/,
    'the Ko-fi webhook lost its form parser — Ko-fi events would stop parsing');
  assert.doesNotMatch(src, /app\.use\(express\.urlencoded/,
    'a GLOBAL urlencoded parser is back — the form-CSRF surface is reopened');
});
