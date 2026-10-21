// Echo-dedup WIRING: the real /chat/native -> /chat/echo-copies -> /chat chain in-process, with
// injected fakes (no Postgres, no live broadcast, no money endpoint).
//
// The decision logic is unit-tested in echo-dedup.test.js and web's echoCopyTiming.test.ts scans
// the call sites; only this proves the route populates the map the handler actually reads.
//
// The 20 s text window is passed by moving the clock (Date only — the HTTP round trips run on
// real timers). That wait is the point: inside 20 s the text window suppresses a matching viewer
// message anyway, so a check that skips it cannot tell the id and sender paths from the text path.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createChat } = require('./chat.js');

test('a send-to-all echo is suppressed by platform id and by sender, and past 20 s only the sender\'s', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const quiet = console.log;
  console.log = () => {};
  t.after(() => { console.log = quiet; });

  const inserted = [];
  const pool = {
    query: async (sql) => {
      if (/INSERT INTO site\.chat_messages/.test(sql)) return { rows: [{ id: 4242 }] };
      if (/INSERT INTO stream\.chat_log/.test(sql)) { inserted.push(sql); return { rows: [{ id: 77, user_id: 'u1' }] }; }
      return { rows: [] };
    },
  };
  const chat = createChat({
    pool,
    // Casey's two linked platform accounts resolve to ONE canonical; everyone else gets their own
    // (a stub that cannot tell two users apart cannot test an identity check).
    resolveOrCreate: async (_platform, userId) =>
      (userId === '55512345' || userId === 'UCabcdefghijklmnopqrstuv') ? 'canon-casey' : `canon-${userId}`,
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

  // Arm a send-to-all, exactly as the web route does.
  await post('/chat/native', {
    matrixId: '@casey:site.test', username: 'Casey', message: 'the fed just cut rates',
    allSend: true, canonicalId: 'canon-casey',
    expectedEchoes: 2, expectedPlatforms: ['twitch', 'youtube'],
    senderPlatformIds: { twitch: '55512345', youtube: 'UCabcdefghijklmnopqrstuv' },
  });

  // Path 1: the exact platform message id.
  await post('/chat/echo-copies', { nativeMsgId: 4242, copies: [{ platform: 'twitch', platformMsgId: 'helix-msg-id-1' }] });
  let before = inserted.length;
  let r = await post('/chat', {
    platform: 'twitch', userId: '55512345', username: 'HostChannel',
    message: 'COMPLETELY DIFFERENT TEXT', platformMsgId: 'helix-msg-id-1',
  });
  assert.equal(r.body?.suppressed, true, 'an id match suppresses even when the text does not match');
  assert.equal(inserted.length, before);
  assert.equal(r.body?.id, 4242, 'an id-suppressed echo returns the native row id');

  // Path 2: sender identity (YouTube has no comparable id).
  before = inserted.length;
  r = await post('/chat', {
    platform: 'youtube', userId: 'UCabcdefghijklmnopqrstuv', username: 'hostchannel',
    message: 'the fed just cut rates', platformMsgId: 'ChwKGk-innertube-id',
  });
  assert.equal(r.body?.suppressed, true, 'the YouTube echo is suppressed by sender identity');
  assert.equal(inserted.length, before);

  // An unregistered id suppresses nothing.
  before = inserted.length;
  r = await post('/chat', { platform: 'twitch', userId: '999', username: 'someone', message: 'unrelated chatter', platformMsgId: 'never-registered' });
  assert.ok(!r.body?.suppressed);
  assert.equal(inserted.length, before + 1);

  // Past the 20 s text window the window reaches the sender's own echo and nothing else.
  t.mock.timers.tick(21_000);

  before = inserted.length;
  r = await post('/chat', { platform: 'youtube', userId: 'UCsomeoneelse0000000000', username: 'a_viewer', message: 'the fed just cut rates', platformMsgId: 'ChwKGk-viewer-id' });
  assert.ok(!r.body?.suppressed, "past 20 s a viewer's identical text lands");
  assert.equal(inserted.length, before + 1);

  before = inserted.length;
  r = await post('/chat', { platform: 'twitch', userId: '777777', username: 'a_twitch_viewer', message: 'the fed just cut rates', platformMsgId: 'twitch-viewer-id' });
  assert.ok(!r.body?.suppressed, 'past 20 s a viewer on a fanned-out platform lands');
  assert.equal(inserted.length, before + 1);

  before = inserted.length;
  r = await post('/chat', { platform: 'youtube', userId: 'UCabcdefghijklmnopqrstuv', username: 'hostchannel', message: 'the fed just cut rates', platformMsgId: 'ChwKGk-late-echo' });
  assert.equal(r.body?.suppressed, true, "past 20 s the sender's own late echo is still suppressed");
  assert.equal(inserted.length, before);
});
