'use strict';

// L2 (owner decision): while a poll runs, a line that is ONLY a valid option number (1–N) is counted
// as the sender's vote and NOT shown — not stored, not broadcast, not in the replay buffer.
// Outside a poll, or a number that is not an option, the line displays normally. /chat/native
// answers { ok: true, id: null, pollVote: { optionN } } for a swallowed vote.
process.env.STREAM_API_SECRET = process.env.STREAM_API_SECRET || 'test-secret-for-poll-votes';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');

function harness({ active = true, options = 3, voteResult = { ok: true } } = {}) {
  const frames = [];
  const buffered = [];
  const inserts = [];
  const votes = [];
  const pool = {
    query: async (sql, params) => {
      if (/INSERT INTO (site\.chat_messages|stream\.chat_log)/.test(sql) || /WITH ins AS/.test(sql)) inserts.push(sql.slice(0, 40));
      if (/WITH ins AS/.test(sql)) return { rows: [{ id: 1, first_msg: false }], rowCount: 1 };
      if (/AS first_msg/.test(sql)) return { rows: [{ first_msg: false }], rowCount: 1 };
      void params;
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const pollEngine = {
    active: () => active,
    current: () => ({ options: Array.from({ length: options }, (_, i) => ({ n: i + 1, text: `opt ${i + 1}` })) }),
    vote: async (v) => { votes.push(v); return voteResult; },
  };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'c0ffee000001', resolveCanonical: async () => 'c0ffee000001',
    pronouns: { get: async () => null, set: async () => true, maybeAlejo: () => {} },
    pollEngine, msgBuffer: [], broadcast: (m) => frames.push(m), bufferPush: (m) => buffered.push(m),
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const call = async (route, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[route]({ body, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  return {
    frames, buffered, inserts, votes,
    post: (message) => call('POST /chat', { platform: 'twitch', userId: 'u1', username: 'casey', message }),
    native: (message) => call('POST /chat/native', { matrixId: '@casey:site.test', username: 'casey', message }),
  };
}
const shown = (h) => h.frames.filter((f) => f.type === 'message').length;

test('platform chat: an option number during a poll is counted and NOT shown, stored or buffered', async () => {
  const h = harness();
  const r = await h.post(' 2 ');
  assert.deepEqual(h.votes.map((v) => [v.voterKey, v.optionN]), [['c0ffee000001', 2]]);
  assert.equal(shown(h), 0, 'the vote line was broadcast');
  assert.equal(h.buffered.length, 0, 'the vote line reached the history buffer');
  assert.equal(h.inserts.length, 0, 'the vote line was stored');
  assert.deepEqual(r.body.pollVote, { optionN: 2 });
  assert.equal(r.body.suppressed, true, 'stream-ingest must be told there is no row to score');
});

test('native chat: an option number during a poll is counted, not shown, and the response says so', async () => {
  const h = harness();
  const r = await h.native('3');
  assert.deepEqual(r.body, { ok: true, id: null, pollVote: { optionN: 3 } });
  assert.deepEqual(h.votes.map((v) => [v.voterKey, v.platform, v.optionN]), [['c0ffee000001', 'native', 3]]);
  assert.equal(shown(h), 0);
  assert.equal(h.buffered.length, 0);
  assert.equal(h.inserts.length, 0, 'a swallowed vote reached site.chat_messages — history would show it');
});

test('a number that is not an option ("12" with 3 options) is shown and not counted', async () => {
  const h = harness();
  await h.post('12');
  const n = await h.native('4');
  assert.equal(h.votes.length, 0);
  assert.equal(shown(h), 2);
  assert.equal(n.body.pollVote, undefined);
});

test('outside a poll an option-looking number displays normally', async () => {
  const h = harness({ active: false });
  await h.post('2');
  const n = await h.native('2');
  assert.equal(h.votes.length, 0);
  assert.equal(shown(h), 2);
  assert.equal(n.body.pollVote, undefined);
});

test('a number with other words is a normal line, not a vote', async () => {
  const h = harness();
  await h.post('2 for sure');
  assert.equal(h.votes.length, 0);
  assert.equal(shown(h), 1);
});

test('a native vote that cannot be stored answers 503 vote_failed and is still not shown', async () => {
  const h = harness({ voteResult: { error: 'store_failed' } });
  const quiet = console.warn;
  console.warn = () => {};
  let r;
  try { r = await h.native('1'); } finally { console.warn = quiet; }
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.body, { ok: false, error: 'vote_failed' });
  assert.equal(shown(h), 0);
});
