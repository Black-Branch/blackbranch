// Echo-dedup WIRING probe — run by hand, not by `node --test`.
//
//   cd stream-api && node echo-wiring.probe.cjs      (~22s; exit 0 = all passed)
//
// Drives the real /chat/native -> /chat/echo-copies -> /chat chain in-process
// with injected fakes: no Postgres, no live broadcast, no money endpoint. This
// exercises the handler in-process rather than probing production.
//
// WHY IT IS NOT IN THE SUITE. createChat() installs a 30s sweep setInterval
// that is not unref'd, so requiring it pins the event loop and `node --test`
// would hang. Fixing that is a process-lifecycle change, which needs its own
// verification by real restarts. If you ever unref that timer, fold this file
// into the suite.
//
// What it covers that nothing else can: the decision logic is unit-tested in
// echo-dedup.test.js, and the call sites are scanned in web's
// echoCopyTiming.test.ts — but only this proves the route actually populates the
// map the handler actually reads.
//
// It really does wait out the 20s window. That wait IS the test: inside 20s
// the text window suppresses a matching viewer message anyway, so a probe that
// skips the wait cannot tell the id/sender paths from the text path.
'use strict';
const express = require('express');
const { createChat } = require('./chat.js');

const inserted = [];
const broadcasts = [];
const pool = {
  query: async (sql) => {
    if (/INSERT INTO site\.chat_messages/.test(sql)) return { rows: [{ id: 4242 }] };
    if (/INSERT INTO stream\.chat_log/.test(sql)) { inserted.push(sql); return { rows: [{ id: 77, user_id: 'u1' }] }; }
    return { rows: [] };
  },
};
const chat = createChat({
  pool,
  // Casey's two linked platform accounts resolve to ONE canonical; everyone else
  // gets their own. (The first version of this stub returned 'canon-casey' for
  // every caller, which made the viewer BE the sender and reported a false
  // failure — a stub that cannot tell two users apart cannot test an identity
  // check.)
  resolveOrCreate: async (_platform, userId) =>
    (userId === '55512345' || userId === 'UCabcdefghijklmnopqrstuv')
      ? 'canon-casey' : `canon-${userId}`,
  resolveCanonical: async () => 'canon-casey',
  pollEngine: { active: () => false },
  msgBuffer: [],
  broadcast: (m) => broadcasts.push(m),
  bufferPush: () => {},
});

const app = express();
app.use(express.json());
chat.registerChatRoutes(app, {
  requireInternal: (_req, _res, next) => next(),
  wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
});

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const fail = [];
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
    if (!cond) fail.push(name);
  };

  // ── Arm a send-to-all, exactly as the web route does ──────────────────────
  await post('/chat/native', {
    matrixId: '@casey:site.test', username: 'Casey', message: 'the fed just cut rates',
    allSend: true, canonicalId: 'canon-casey',
    expectedEchoes: 2, expectedPlatforms: ['twitch', 'youtube'],
    senderPlatformIds: { twitch: '55512345', youtube: 'UCabcdefghijklmnopqrstuv' },
  });

  // ── Path 1: exact platform message id, long after the text window ─────────
  await post('/chat/echo-copies', {
    nativeMsgId: 4242, copies: [{ platform: 'twitch', platformMsgId: 'helix-msg-id-1' }],
  });
  let before = inserted.length;
  let r = await post('/chat', {
    platform: 'twitch', userId: '55512345', username: 'HostChannel',
    message: 'COMPLETELY DIFFERENT TEXT', platformMsgId: 'helix-msg-id-1',
  });
  check('id match suppresses even when the TEXT does not match at all',
    r.body?.suppressed === true && inserted.length === before, `id=${r.body?.id}`);
  check('an id-suppressed echo returns the native row id', r.body?.id === 4242);

  // ── Path 2: sender identity, past the 20s text window ─────────────────────
  before = inserted.length;
  r = await post('/chat', {
    platform: 'youtube', userId: 'UCabcdefghijklmnopqrstuv', username: 'hostchannel',
    message: 'the fed just cut rates', platformMsgId: 'ChwKGk-innertube-id',
  });
  check('YouTube echo suppressed by SENDER IDENTITY (no comparable id exists)',
    r.body?.suppressed === true && inserted.length === before);

  // ── An unregistered id must not suppress anything ─────────────────────────
  before = inserted.length;
  r = await post('/chat', {
    platform: 'twitch', userId: '999', username: 'someone',
    message: 'unrelated chatter', platformMsgId: 'never-registered',
  });
  check('an unknown id does not suppress', !r.body?.suppressed && inserted.length === before + 1);

  // ── The safety property, tested where it actually matters ────────────────
  // Inside 20s the TEXT window swallows a matching viewer message, and always
  // has — that is the documented, pre-existing trade-off this change is
  // deliberately NOT widening. What must hold is that PAST 20s the newly-opened
  // window reaches the sender's own echo and nothing else. So wait it out.
  console.log('\n  … waiting out the 20s text window (this is the whole point) …');
  await new Promise((r) => setTimeout(r, 21_000));

  before = inserted.length;
  r = await post('/chat', {
    platform: 'youtube', userId: 'UCsomeoneelse0000000000', username: 'a_viewer',
    message: 'the fed just cut rates', platformMsgId: 'ChwKGk-viewer-id',
  });
  check("PAST 20s: a VIEWER's identical text lands",
    !r.body?.suppressed && inserted.length === before + 1);

  before = inserted.length;
  r = await post('/chat', {
    platform: 'twitch', userId: '777777', username: 'a_twitch_viewer',
    message: 'the fed just cut rates', platformMsgId: 'twitch-viewer-id',
  });
  check('PAST 20s: a viewer on a FANNED-OUT platform lands',
    !r.body?.suppressed && inserted.length === before + 1);

  before = inserted.length;
  r = await post('/chat', {
    platform: 'youtube', userId: 'UCabcdefghijklmnopqrstuv', username: 'hostchannel',
    message: 'the fed just cut rates', platformMsgId: 'ChwKGk-late-echo',
  });
  check("PAST 20s: the SENDER's own late echo is suppressed (the bug being fixed)",
    r.body?.suppressed === true && inserted.length === before);

  server.close();
  console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall in-process checks passed');
  process.exit(fail.length ? 1 : 0);
});
