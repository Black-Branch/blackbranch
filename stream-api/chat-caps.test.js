// Length caps at the /chat and /chat/native boundaries.
//
// The express body limit is ~100KB, so without caps a compromised or buggy
// producer could POST a 90KB message that then rides EVERYWHERE the text goes: the chat_log INSERT, the broadcast to
// every client, and — the expensive one — the 200-entry msgBuffer, which is
// replayed as `history` to every connecting client for as long as it stays
// buffered (200 × 90KB ≈ 18MB per connect).
//
// The caps are deliberately far above anything a legitimate producer sends —
// native web sanitizes to 500 chars, Twitch's max is 500, YouTube's 200 — so
// truncation is invisible to real traffic; only the abuse shape is cut. The
// clamp TRUNCATES rather than rejects: on this pipeline a dropped message is
// worse than a shortened one.
//
// The policy is pure in chat-dedup.js (this file tests it); the wiring scan
// pins that BOTH routes apply it before the text reaches identity/DB/buffer.
//
// Run: node --test chat-caps.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { clampLen, MAX_MESSAGE_LEN, MAX_USERNAME_LEN, MAX_REPLY_TEXT_LEN } = require('./chat-dedup.js');

test('clampLen and the three caps are exported', () => {
  assert.equal(typeof clampLen, 'function');
  assert.equal(typeof MAX_MESSAGE_LEN, 'number');
  assert.equal(typeof MAX_USERNAME_LEN, 'number');
  assert.equal(typeof MAX_REPLY_TEXT_LEN, 'number');
});

test('caps sit far above every legitimate producer, below the body limit', () => {
  // ≥ 4× the largest platform message (Twitch 500) so no real send is touched;
  // ≤ a small fraction of the ~100KB body limit so the buffer replay stays sane.
  assert.ok(MAX_MESSAGE_LEN >= 2000 && MAX_MESSAGE_LEN <= 8000,
    `MAX_MESSAGE_LEN=${MAX_MESSAGE_LEN} is outside the defensible band`);
  assert.ok(MAX_USERNAME_LEN >= 100 && MAX_USERNAME_LEN <= 200);
  assert.ok(MAX_REPLY_TEXT_LEN >= 200 && MAX_REPLY_TEXT_LEN <= 1000);
});

test('an over-cap message is truncated to the cap', () => {
  const out = clampLen('x'.repeat(90_000), MAX_MESSAGE_LEN);
  assert.equal(out.length, MAX_MESSAGE_LEN);
});

test('a normal message passes through untouched — same reference', () => {
  const s = 'hello chat';
  assert.strictEqual(clampLen(s, MAX_MESSAGE_LEN), s);
});

test('non-strings pass through unchanged — the routes validate those themselves', () => {
  assert.strictEqual(clampLen(null, 100), null);
  assert.strictEqual(clampLen(undefined, 100), undefined);
  assert.strictEqual(clampLen(42, 100), 42);
});

// ── Wiring: both routes clamp at the boundary ───────────────────────────────
// Comment-stripped scan (line comments first — chat.js documents routes in
// prose that names every term below), vacuity anchor on the file's tail.

const src = readFileSync(join(__dirname, 'chat.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the scan sees the whole of chat.js, tail included', () => {
  assert.match(src, /module\.exports = \{ createChat \};\s*$/,
    'the scan lost the END of chat.js — the /chat/native assertions below are checking a truncated file');
});

test('/chat clamps message and username before anything consumes them', () => {
  const start = src.indexOf("app.post('/chat',");
  const end = src.indexOf("app.post('/chat/echo-copies'");
  assert.ok(start !== -1 && end > start, 'route extraction failed — chat.js route order changed');
  const block = src.slice(start, end);
  const firstClamp = block.indexOf('clampLen(');
  assert.ok(firstClamp !== -1, '/chat no longer clamps its inbound fields');
  const firstUse = block.indexOf('resolveOrCreate(');
  assert.ok(firstUse === -1 || firstClamp < firstUse,
    '/chat clamps AFTER identity resolution — an unbounded username already hit stream.users/nameidx');
});

test('/chat/native clamps message and username at the boundary too', () => {
  const start = src.indexOf("app.post('/chat/native'");
  assert.ok(start !== -1, 'route extraction failed — /chat/native moved');
  const block = src.slice(start);
  assert.ok(block.includes('clampLen('),
    '/chat/native no longer clamps — Gadget/brain callers bypass the web sanitizer entirely');
});
