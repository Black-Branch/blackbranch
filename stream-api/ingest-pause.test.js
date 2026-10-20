// The lockdown's ingest lever, run for
// real: POST /chat drops a paused platform's message before anything is looked up or written,
// answers 200 (so ingest does not retry), and fails OPEN when the lever cannot be read.
//
// Run: node --test ingest-pause.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');
const { isIngestPaused, _resetIngestPause } = require('./ingest-pause');

function harness(paused, { failLever = false } = {}) {
  _resetIngestPause();
  const queries = [];
  let resolved = 0;
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM site\.lockdown_now/.test(sql) && /ingest_paused/.test(sql)) {
        if (failLever) throw new Error('db down');
        return { rows: [{ ingest_paused: paused }] };
      }
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const chat = createChat({
    pool, resolveOrCreate: async () => { resolved++; return 'abc'; }, resolveCanonical: async () => null,
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [], broadcast: () => {}, bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['POST /chat']({ body, ip: '127.0.0.1' }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  const writes = () => queries.filter((q) => /INSERT INTO stream\.chat_log/.test(q.sql));
  return { post, writes, resolvedCount: () => resolved };
}

const msg = (over = {}) => ({ platform: 'kick', userId: 'u1', username: 'kate', message: 'hello', ...over });

test('a paused platform: dropped with 200 + filtered, never resolved, never stored', async () => {
  const h = harness(['kick']);
  const res = await h.post(msg());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, filtered: true, reason: 'ingest_paused' });
  assert.equal(h.resolvedCount(), 0, 'nothing looked up for a dropped message');
  assert.equal(h.writes().length, 0);
});

test('another platform is taken in as usual', async () => {
  const h = harness(['kick']);
  const res = await h.post(msg({ platform: 'twitch' }));
  assert.notEqual(res.body?.reason, 'ingest_paused');
  assert.equal(h.resolvedCount(), 1);
});

test('the site\'s own chat is never paused, and a mod releasing a held message is not ingest', async () => {
  const h = harness(['kick', 'native']);
  const own = await h.post(msg({ platform: 'native' }));
  assert.notEqual(own.body?.reason, 'ingest_paused');
  const released = await h.post(msg({ releaseHold: true }));
  assert.notEqual(released.body?.reason, 'ingest_paused');
});

test('fails OPEN: an unreadable lever pauses nothing', async () => {
  const h = harness(['kick'], { failLever: true });
  const res = await h.post(msg());
  assert.notEqual(res.body?.reason, 'ingest_paused');
  assert.equal(h.resolvedCount(), 1);
});

test('the lever is cached for 5 s, then re-read', async () => {
  _resetIngestPause();
  let reads = 0;
  let value = ['youtube'];
  const pool = { query: async () => { reads++; return { rows: [{ ingest_paused: value }] }; } };
  assert.equal(await isIngestPaused(pool, 'youtube', 100_000), true);
  value = [];
  assert.equal(await isIngestPaused(pool, 'youtube', 104_000), true, 'cached');
  assert.equal(reads, 1);
  assert.equal(await isIngestPaused(pool, 'youtube', 105_001), false, 're-read after 5 s');
  assert.equal(reads, 2);
});
