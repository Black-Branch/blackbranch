// The one invariant that makes Supporter encrypted messages safe.
//
// /chat/native takes an `encryptedText` alongside the scrambled `message`. The
// scramble is what everything downstream sees; the plaintext is written to the
// row and read back only by web's authenticated /api/chat/decrypt.
//
// THE EXPOSURE IS THE WS LAYER, NOT THE DATABASE. `broadcast()` sends the
// frame to every connected client, AND ws-hub keeps the last 200 frames in
// `msgBuffer`, replayed as `history` to everyone who connects afterwards. One
// plaintext in that buffer reaches every future viewer, with no auth check
// anywhere in the path — and it persists for the next 200 messages, long after
// the mistake is made. So the plaintext must never be ON the frame at all,
// rather than filtered out of it somewhere.
//
// createChat pulls a live pool + poll engine through its factory, so these are
// source-level assertions on the handler rather than route invocations. That is
// a real limitation: a scan proves the shape of the code, not its behaviour.
// It is chosen deliberately here because the invariant IS structural — "this
// identifier does not appear in that object literal" — and a behavioural test
// with a mocked broadcast would pass just as happily if someone later added the
// field to a DIFFERENT frame this file never exercised.
//
// Run: node --test encrypted-native.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, 'chat.js'), 'utf8');

/** The `const msg = { … }` frame literal inside /chat/native. */
function nativeFrame() {
  const handler = src.slice(src.indexOf("app.post('/chat/native'"));
  const start = handler.indexOf('const msg = {');
  assert.notEqual(start, -1, 'could not find the /chat/native broadcast frame');
  const end = handler.indexOf('bufferPush(msg)', start);
  assert.notEqual(end, -1, 'could not find the end of the frame literal');
  return handler.slice(start, end);
}

test('the broadcast frame does not carry the plaintext', () => {
  const frame = nativeFrame();
  assert.ok(!frame.includes('encryptedText'), 'encryptedText is on the broadcast frame');
  // NOT a bare `includes('encText')`. The frame legitimately MENTIONS the
  // local — `encrypted: encText != null` derives the flag from it — so a name
  // check fails on correct code. What must not appear is the value being
  // assigned to a property: `something: encText` or a bare `encText,` shorthand.
  assert.ok(
    !/:\s*encText\s*[,}\n]/.test(frame),
    'the plaintext local is assigned to a field on the broadcast frame'
  );
  assert.ok(!/[{,]\s*encText\s*[,}]/.test(frame), 'encText is shorthand-spread onto the frame');
});

test('the frame carries the encrypted FLAG, so clients know to offer a decrypt', () => {
  // The other half: without this, an encrypted message renders as a wall of
  // glyphs that nothing offers to open, which reads as a bug rather than a
  // feature. Pinned as a derivation from the payload — a hardcoded `false`
  // would satisfy a bare name check.
  const frame = nativeFrame();
  assert.match(frame, /encrypted:\s*encText\s*!=\s*null/,
    'the flag must be derived from the payload, so the two cannot drift');
});

test('the plaintext is written in the SAME INSERT as the message', () => {
  // Not a follow-up UPDATE. The frame is broadcast the moment the INSERT
  // returns, so a two-step write leaves a window where a fast client can ask to
  // decrypt a message whose plaintext does not exist yet — and the natural
  // "fix" for that is client-side retries papering over a race.
  // Both offsets measured from the INSERT. Anchoring the end on a bare
  // `indexOf('RETURNING id')` searched from position 0 and landed BEFORE the
  // INSERT, producing an empty slice — an assertion that failed on correct code
  // and would just as easily have passed on broken code with the other operand.
  const from = src.indexOf('INSERT INTO site.chat_messages');
  assert.notEqual(from, -1, 'the native INSERT is gone');
  // The end anchor needs its own guard: with `RETURNING id` gone, slice(from, -1)
  // spans nearly the whole file, and `includes('encrypted_text')` would be satisfied
  // by ANY later mention — the region must be the INSERT, not the tail of the file.
  const to = src.indexOf('RETURNING id', from);
  assert.notEqual(to, -1, 'the native INSERT no longer ends with RETURNING id');
  const insert = src.slice(from, to);
  assert.ok(insert.includes('encrypted_text'), 'encrypted_text is not in the native INSERT');
  assert.ok(
    !/UPDATE\s+site\.chat_messages[\s\S]{0,200}encrypted_text/i.test(src),
    'encrypted_text must never be written by a second statement'
  );
});

test('the stored plaintext is length-capped', () => {
  // /chat/native is reachable by anything holding the internal secret, so the
  // field takes a bound like every other free-text input on this route.
  const region = src.slice(src.indexOf('req.body.encryptedText'));
  assert.match(region.slice(0, 300), /\.slice\(0,\s*\d+\)/, 'encryptedText is stored unbounded');
});
