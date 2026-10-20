// Personal Twitch emotes at the /chat/native boundary.
//
// The map is produced by web chat/send from the SENDER's own Helix set and is
// rendered as <img src> by every client, so this boundary host-pins URLs to
// Twitch's emote CDN and caps entries — /chat/native must not become an
// arbitrary-image injection door. Policy is pure in chat-dedup.js; the wiring
// scan pins that the native route actually applies it, stores it, broadcasts it.
//
// Run: node --test native-emotes.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { sanitizeNativeEmotes } = require('./chat-dedup.js');

const URL_OK = 'https://static-cdn.jtvnw.net/emoticons/v2/12345/static/dark/3.0';

test('a valid map passes through', () => {
  assert.deepEqual(sanitizeNativeEmotes({ KEKW: URL_OK }), { KEKW: URL_OK });
});

test('non-objects and arrays are null', () => {
  assert.equal(sanitizeNativeEmotes(null), null);
  assert.equal(sanitizeNativeEmotes('x'), null);
  assert.equal(sanitizeNativeEmotes(['a']), null);
  assert.equal(sanitizeNativeEmotes(42), null);
});

test('a non-jtvnw URL is dropped — host pin', () => {
  assert.equal(sanitizeNativeEmotes({ evil: 'https://example.com/x.png' }), null);
  assert.equal(sanitizeNativeEmotes({ evil: 'http://static-cdn.jtvnw.net/x' }), null, 'https only');
});

test('oversized name/url dropped; map empty after filtering is null', () => {
  assert.equal(sanitizeNativeEmotes({ ['x'.repeat(101)]: URL_OK }), null);
  assert.equal(sanitizeNativeEmotes({ a: URL_OK + 'x'.repeat(300) }), null);
});

test('entry cap truncates at 50', () => {
  const big = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`e${i}`, URL_OK]));
  const out = sanitizeNativeEmotes(big);
  assert.equal(Object.keys(out).length, 50);
});

test('mixed map keeps only the valid entries', () => {
  const out = sanitizeNativeEmotes({ Good: URL_OK, Bad: 'https://example.com/x' });
  assert.deepEqual(out, { Good: URL_OK });
});

// ── Wiring: the native route applies the policy, stores it, broadcasts it ────

const src = readFileSync(join(__dirname, 'chat.js'), 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('the scan sees the whole of chat.js, tail included', () => {
  assert.match(src, /module\.exports = \{ createChat \};\s*$/,
    'the scan lost the END of chat.js — the assertions below check a truncated file');
});

test('/chat/native sanitizes, INSERTs, and broadcasts the emote map', () => {
  const start = src.indexOf("app.post('/chat/native'");
  assert.ok(start !== -1, 'native route not found');
  const block = src.slice(start);
  const sanit = block.indexOf('sanitizeNativeEmotes(req.body.emotes)');
  const insert = block.indexOf('INSERT INTO site.chat_messages');
  assert.ok(sanit !== -1, 'native route does not sanitize req.body.emotes');
  assert.ok(insert !== -1 && sanit < insert, 'sanitize must precede the INSERT');
  assert.match(block.slice(insert, insert + 400), /emotes/,
    'the site.chat_messages INSERT does not include the emotes column');
  assert.match(block, /\.\.\.\(nativeEmotes && \{ emotes: nativeEmotes \}\)/,
    'the broadcast msg frame does not carry the map');
});

test('nativeEmotes is null for encrypted rows — defense-in-depth at the boundary that owns the public history buffer', () => {
  const start = src.indexOf("app.post('/chat/native'");
  const block = src.slice(start);
  assert.match(block, /const nativeEmotes = encText \? null : sanitizeNativeEmotes\(req\.body\.emotes\);/,
    'nativeEmotes must be gated null when encText is set — an emote map\'s keys are plaintext words');
  const encTextIdx = block.indexOf('const encText =');
  const nativeEmotesIdx = block.indexOf('const nativeEmotes =');
  assert.ok(encTextIdx !== -1 && nativeEmotesIdx !== -1 && encTextIdx < nativeEmotesIdx,
    'encText must be computed before nativeEmotes so the gate can reference it');
});
