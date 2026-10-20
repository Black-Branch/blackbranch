// /chat/native must broadcast BEFORE its non-display bookkeeping — the
// chat-send hot path.
//
// Awaiting site INSERT → canonical resolve → last_seen UPDATE → corpus
// chat_log INSERT serially before the broadcast puts four-plus DB round-trips
// between hitting Enter and the message appearing, on the most common user
// action. The corpus row is non-display ("only feeds scoring/stats/recall").
//
// What must stay pre-broadcast: the site.chat_messages INSERT (it mints the
// frame's id) and the canonical resolve (the frame + poll vote carry it).
//
// Source-level assertions, same trade as encrypted-native.test.js: createChat
// pulls a live pool through its factory, and the invariant here is ORDER of
// statements in one handler — structural by nature.
//
// Run: node --test chat-native-latency.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, 'chat.js'), 'utf8');

/** The /chat/native handler, from its route registration to end of file. */
function nativeHandler() {
  const start = src.indexOf("app.post('/chat/native'");
  assert.notEqual(start, -1, 'the /chat/native route is gone');
  return src.slice(start);
}

test('the corpus chat_log INSERT runs after the response, not before the broadcast', () => {
  const h = nativeHandler();
  const broadcastAt = h.indexOf('broadcast(msg)');
  const respondAt = h.indexOf('res.json({ ok: true, id: chatId })');
  const corpusAt = h.indexOf('INSERT INTO stream.chat_log');
  assert.notEqual(broadcastAt, -1, 'vacuity anchor: broadcast(msg) is gone from /chat/native');
  assert.notEqual(respondAt, -1, 'vacuity anchor: the ok response is gone from /chat/native');
  assert.notEqual(corpusAt, -1,
    'vacuity anchor: the corpus INSERT is gone from /chat/native — Gadget loses native memory');
  assert.ok(corpusAt > broadcastAt,
    'the corpus INSERT sits before broadcast — every native send pays a non-display DB round-trip before anyone sees it');
  assert.ok(corpusAt > respondAt,
    'the corpus INSERT sits before the response — the sender waits on bookkeeping');
});

test('native last_seen goes through the same 30s throttle as platform chat', () => {
  const h = nativeHandler();
  const lastSeenAt = h.indexOf('SET last_seen');
  assert.notEqual(lastSeenAt, -1, 'vacuity anchor: the native last_seen write is gone');
  assert.match(h, /shouldTouchLastSeen\(nativeCanon\)/,
    'native last_seen is unthrottled — a chatty native user UPDATEs stream.users on every message while the platform path writes once per 30s');
});

test('what mints the frame stays pre-broadcast: site INSERT and canonical resolve', () => {
  // The other direction — the speedup must not move the id mint or the
  // identity resolve past the frame that carries them.
  const h = nativeHandler();
  const broadcastAt = h.indexOf('broadcast(msg)');
  const siteInsertAt = h.indexOf('INSERT INTO site.chat_messages');
  const resolveAt = h.indexOf('resolveOrCreate(');
  assert.notEqual(siteInsertAt, -1, 'vacuity anchor: the site INSERT is gone');
  assert.notEqual(resolveAt, -1, 'vacuity anchor: the canonical resolve is gone');
  assert.ok(siteInsertAt < broadcastAt, 'the frame id must exist before it is broadcast');
  assert.ok(resolveAt < broadcastAt, 'the frame carries canonicalId — resolve must precede it');
});
