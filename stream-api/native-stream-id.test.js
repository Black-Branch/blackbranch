// /chat/native's corpus row must carry the LIVE stream id when the caller
// sends none — and web never sends one.
//
// The profile card's `streams` is aggregates.js's COUNT(DISTINCT
// cl.stream_id). Platform messages arrive stamped by ingest, but a native row
// INSERTed with `streamId || null` from a body that never has one carries no
// stream, so anyone who chats natively stops counting streams.
//
// Source-level, like the other /chat/native tests: createChat pulls a live
// pool through its factory. The executable half is the helper's fallback
// shape, which this file pins in place of a route test.
//
// Run: node --test native-stream-id.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const chatSrc = readFileSync(join(__dirname, 'chat.js'), 'utf8');
const indexSrc = readFileSync(join(__dirname, 'index.js'), 'utf8');

/** The /chat/native handler, from its route registration to end of file. */
function nativeHandler() {
  const start = chatSrc.indexOf("app.post('/chat/native'");
  assert.notEqual(start, -1, 'the /chat/native route is gone');
  return chatSrc.slice(start);
}

test('createChat accepts getStreamId and the corpus INSERT uses the resolved id', () => {
  assert.match(chatSrc.trimEnd(), /module\.exports = \{ createChat \};$/,
    'chat.js did not end as expected — the read is truncated');
  assert.match(chatSrc, /getStreamId = async \(\) => null \}\) \{/,
    'createChat must default getStreamId so the source-scan tests that construct nothing still describe a working factory');
  const h = nativeHandler();
  const fallbackAt = h.indexOf('const sid = streamId || await getStreamId().catch(() => null);');
  const insertAt = h.indexOf('INSERT INTO stream.chat_log');
  assert.notEqual(fallbackAt, -1, 'the live-stream fallback is gone from /chat/native');
  assert.notEqual(insertAt, -1, 'vacuity anchor: the corpus INSERT is gone');
  assert.ok(fallbackAt < insertAt, 'the fallback must be resolved BEFORE the corpus INSERT that stores it');
  assert.match(h, /VALUES \(\$1,\$9,\$2,\$3,\$4,false,\$5,\$6,\$7,\$8\)`,\s*\[nativeCanon, username \|\| matrixId, message, sid \|\| null, cwc,/,
    'the INSERT must bind the RESOLVED id, not the raw body value');
  assert.doesNotMatch(h, /message, streamId \|\| null, cwc/,
    'the raw body value survived into the corpus INSERT — native rows would stay unattributed');
  // Behind the response, like the rest of the corpus bookkeeping.
  const respondAt = h.indexOf('res.json({ ok: true, id: chatId })');
  assert.ok(respondAt !== -1 && respondAt < fallbackAt, 'the fallback lookup (two queries) must ride behind the response');
});

test('index.js wires the same live-session lookup the support bar uses', () => {
  assert.match(indexSrc.slice(-400), /\n\}\);\s*$|\n\}\s*$/, 'index.js did not end as expected — the read is truncated');
  assert.match(indexSrc,
    /createChat\(\{ pool, resolveOrCreate, resolveCanonical, pronouns, pollEngine,\s*msgBuffer, broadcast, bufferPush,\s*getStreamId: async \(\) => \(await liveState\(\)\)\.streamId \|\| null \}\)/,
    'createChat must be given getStreamId from lifecycle.liveState — the default is null and the row stays unattributed');
});
