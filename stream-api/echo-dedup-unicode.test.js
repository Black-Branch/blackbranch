// Ticket #126: one site message in Arabic was shown three times. The site stored the
// line as typed — ba, shadda, fatha (U+0628 U+0651 U+064E) — and Twitch and YouTube
// both echoed it back in canonical order — ba, fatha, shadda (U+0628 U+064E U+0651),
// because fatha (combining class 30) sorts before shadda (33). The two strings are
// the same text and render identically, but normText compared code points, so the
// echo keys missed the armed key and each platform's copy landed as a new line.
//
// The fix is Unicode NFC at the ONE place the dedup key is built (normText, plus its
// path-keeping twin). NFC and not NFKC: NFKC also folds compatibility characters
// ("ﬁ" → "fi", fullwidth "ｌｏｌ" → "lol"), which are visibly different text — a
// viewer's line must never be merged into someone else's on the strength of that.
//
// Run: node --test echo-dedup-unicode.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const express = require('express');
const { normText, normTextWithPath } = require('./chat-dedup');
const { createChat } = require('./chat.js');

// The real bytes from ticket #126 (site row 144021 vs chat_log 317484 / 317486),
// inside a made-up sentence so the key has more than one word in it.
const SITE_TYPED = 'مرحبا بَّ يا شباب';      // ba · shadda · fatha (as typed)
const PLATFORM_ECHO = 'مرحبا بَّ يا شباب';   // ba · fatha · shadda (canonical order)
// A third platform could hand back the fully decomposed or a precomposed form of a
// letter with hamza — ALEF WITH HAMZA ABOVE (U+0623) vs ALEF + HAMZA ABOVE (U+0627 U+0654).
const SITE_HAMZA = 'سؤال أحمد';
const ECHO_HAMZA = 'سؤال أحمد';

test('#126: the Arabic line and its canonical-order echo are ONE dedup key', () => {
  assert.notEqual(SITE_TYPED, PLATFORM_ECHO, 'precondition: the two byte sequences really differ');
  assert.equal(normText(PLATFORM_ECHO), normText(SITE_TYPED), 'the echo key differs from the armed key — the echo posts as a new line');
  assert.equal(normTextWithPath(PLATFORM_ECHO), normTextWithPath(SITE_TYPED));
  assert.equal(normText(ECHO_HAMZA), normText(SITE_HAMZA), 'a decomposed hamza must key like the precomposed one');
});

test('#126: NFC only — visibly different Latin text is NOT merged', () => {
  // Compatibility folds (NFKC) would merge these; they are different text on screen.
  assert.notEqual(normText('ﬁle'), normText('file'), 'a ligature was folded into plain letters (NFKC, not NFC)');
  assert.notEqual(normText('ｌｏｌ'), normText('lol'), 'fullwidth letters were folded (NFKC, not NFC)');
  assert.notEqual(normText('x²'), normText('x2'), 'a superscript was folded (NFKC, not NFC)');
  // An accent is a different word, composed or not.
  assert.notEqual(normText('cafe'), normText('café'));
  assert.equal(normText('café'), normText('café'), 'precondition for the line above: composed and decomposed é are one key');
});

test('#126: a zero-width character between a letter and its mark does not split the key', () => {
  // The strip runs BEFORE NFC, so a platform that drops a zero-width joiner still
  // composes to the same key as the copy that kept it.
  assert.equal(normText('cafe‍́'), normText('café'));
});

/** The real /chat/native → /chat chain, in-process (no Postgres, no broadcast). */
async function chatServer(t) {
  const inserted = [];
  const pool = {
    query: async (sql) => {
      if (/INSERT INTO site\.chat_messages/.test(sql)) return { rows: [{ id: 5151 }] };
      if (/INSERT INTO stream\.chat_log/.test(sql)) { inserted.push(sql); return { rows: [{ id: 88, user_id: 'u1' }] }; }
      return { rows: [] };
    },
  };
  const quiet = console.log;
  console.log = () => {};
  t.after(() => { console.log = quiet; });
  const chat = createChat({
    pool,
    resolveOrCreate: async (_p, userId) => `canon-${userId}`,
    resolveCanonical: async () => 'canon-casey',
    pollEngine: { active: () => false },
    msgBuffer: [],
    broadcast: () => {},
    bufferPush: () => {},
  });
  const app = express();
  app.use(express.json());
  chat.registerChatRoutes(app, {
    requireInternal: (_req, _res, next) => next(),
    wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(b),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { post, inserted };
}

const armBody = (message) => ({
  matrixId: '@casey:site.test', username: 'Casey', message,
  allSend: true, canonicalId: 'canon-casey',
  expectedEchoes: 3, expectedPlatforms: ['twitch', 'youtube', 'kick'],
});

test('#126 original path: one Arabic send-to-all, three platform echoes, ONE line', async (t) => {
  const { post, inserted } = await chatServer(t);
  await post('/chat/native', armBody(SITE_TYPED));
  const before = inserted.length; // /chat/native writes its own chat_log mirror row
  // Echoes come back from the host channel's accounts (not the sender's), so only the
  // text key can match them — exactly the case the ticket describes.
  for (const [platform, msg] of [['twitch', PLATFORM_ECHO], ['youtube', PLATFORM_ECHO], ['kick', SITE_TYPED]]) {
    const r = await post('/chat', { platform, userId: `host-${platform}`, username: 'hostchannel', message: msg, platformMsgId: `${platform}-1` });
    assert.equal(r.body?.suppressed, true, `the ${platform} echo was not suppressed — it would post as a second line`);
  }
  assert.equal(inserted.length, before, 'an echo reached stream.chat_log as a new line');
});

test('#126 retry: the same echo delivered twice (an ingest retry) is still one line', async (t) => {
  const { post, inserted } = await chatServer(t);
  await post('/chat/native', armBody(SITE_TYPED));
  const before = inserted.length;
  for (let i = 0; i < 2; i++) {
    const r = await post('/chat', { platform: 'twitch', userId: 'host-twitch', username: 'hostchannel', message: PLATFORM_ECHO, platformMsgId: 'twitch-1' });
    assert.equal(r.body?.suppressed, true, `delivery ${i + 1} of the same echo was not suppressed`);
  }
  assert.equal(inserted.length, before);
});

test('#126 restart: the key is a pure function — a fresh process builds the same key', () => {
  // The armed map lives in one process; what must survive a restart is that the key
  // an echo is matched by does not depend on anything but the text.
  const script = `const { normText } = require(${JSON.stringify(require.resolve('./chat-dedup'))});
    process.stdout.write(JSON.stringify([normText(process.argv[1]), normText(process.argv[2])]));`;
  const [a, b] = JSON.parse(execFileSync(process.execPath, ['-e', script, SITE_TYPED, PLATFORM_ECHO], { encoding: 'utf8' }));
  assert.equal(a, b, 'a fresh process keys the two forms differently');
  assert.equal(a, normText(PLATFORM_ECHO), 'a fresh process keys the line differently from this one');
});

test('#126: a viewer typing different Latin text into the window is not swallowed', async (t) => {
  const { post, inserted } = await chatServer(t);
  await post('/chat/native', armBody('the café is open'));
  const before = inserted.length;
  const r = await post('/chat', { platform: 'twitch', userId: 'viewer-1', username: 'a_viewer', message: 'the cafe is open', platformMsgId: 'v-1' });
  assert.ok(!r.body?.suppressed, 'a different word was merged into the armed send');
  assert.equal(inserted.length, before + 1);
});
