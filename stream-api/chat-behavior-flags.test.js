'use strict';

// The bot's account is CONFIGURED (instance key bot.matrixId) — there is no hardcoded default, so the test says which account is the bot.
process.env.BOT_MATRIX_ID = '@helperbot:site.test';
// Every chat frame says whether the sender is a bot (the server's own bot list —
// BOT_USERNAMES upstream in stream-ingest, GADGET_MATRIX_ID here), and marks a
// person's first message ever. Executed through the routes with a recording pool.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createChat } = require('./chat');

function harness({ first = false } = {}) {
  const frames = [];
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/WITH ins AS/.test(sql)) return { rows: [{ id: 1, first_msg: first }], rowCount: 1 };
      if (/AS first_msg/.test(sql)) return { rows: [{ first_msg: first }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const chat = createChat({
    pool, resolveOrCreate: async () => 'abc', resolveCanonical: async () => 'abc',
    pronouns: { get: async () => null, set: async () => true, maybeAlejo: () => {} },
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [],
    broadcast: (m) => frames.push(m), bufferPush: () => {},
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
  return { frames, queries, post: (b) => call('POST /chat', b), native: (b) => call('POST /chat/native', b) };
}

const plat = (over = {}) => ({ platform: 'twitch', userId: 'u1', username: 'kate', message: 'hello there', ...over });
const site = (over = {}) => ({ matrixId: '@kate:site.test', username: 'kate', message: 'hello there', ...over });
const msgFrames = (h) => h.frames.filter((f) => f.type === 'message');

test('platform frames carry isBot from the ingest bot list', async () => {
  const h = harness();
  await h.post(plat({ isBot: true, username: 'nightbot' }));
  await h.post(plat());
  assert.deepEqual(msgFrames(h).map((f) => f.isBot), [true, false]);
});

test('site frames: the configured Gadget account is a bot, a person is not', async () => {
  const h = harness();
  await h.native(site({ matrixId: '@helperbot:site.test', username: 'Gadget' }));
  await h.native(site());
  assert.deepEqual(msgFrames(h).map((f) => f.isBot), [true, false]);
});

test('a first message ever is marked, on both paths', async () => {
  const p = harness({ first: true });
  await p.post(plat());
  assert.equal(msgFrames(p)[0].isFirst, true);
  const s = harness({ first: true });
  await s.native(site());
  assert.equal(msgFrames(s)[0].isFirst, true);
  const old = harness({ first: false });
  await old.post(plat());
  await old.native(site());
  assert.deepEqual(msgFrames(old).map((f) => f.isFirst ?? false), [false, false]);
});

test('bots are never marked first', async () => {
  const h = harness({ first: true });
  await h.post(plat({ isBot: true }));
  await h.native(site({ matrixId: '@helperbot:site.test' }));
  assert.deepEqual(msgFrames(h).map((f) => f.isFirst ?? false), [false, false]);
});

test('a quick second message is not "first" again, even before the first reached the log', async () => {
  // The site path writes its chat_log row AFTER the response, so the database can
  // still say "no earlier row" for the next message.
  const h = harness({ first: true });
  await h.native(site());
  await h.native(site({ message: 'again' }));
  await h.post(plat());
  assert.deepEqual(msgFrames(h).map((f) => f.isFirst ?? false), [true, false, false]);
});

test('the first-message check reads the log BEFORE this row, keyed on the canonical id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.js'), 'utf8');
  // Same statement as the INSERT: a data-modifying CTE's row is invisible to the
  // rest of the statement, so NOT EXISTS sees only earlier rows.
  assert.match(src, /NOT EXISTS \(SELECT 1 FROM stream\.chat_log p WHERE p\.user_id = \$1\) AS first_msg\s+FROM ins/);
  assert.match(src.slice(-120), /module\.exports = \{ createChat \};\s*$/, 'END anchor');
});
