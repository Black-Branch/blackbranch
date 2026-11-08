// A mod's Allow on a held platform line (web app/api/mod/automod/resolve) re-posts it to POST /chat
// with releaseHold. It used to send the name only, so /chat minted a brand-new canonical with no
// platform link on every release: the line came from a stranger with no history, a ban or purge
// from it landed on the stranger, and a sender banned between the hold and the Allow was published
// anyway (the ban hold was asked about the stranger). The held row carries its sender's canonical
// (site.automod_held.user_id); the release passes it, /chat posts under it and refuses a held one.
//
// Run: node --test chat-release.test.js
'use strict';
process.env.STREAM_API_SECRET = process.env.STREAM_API_SECRET || 'test-secret-for-release';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChat } = require('./chat');
const { _resetIngestPause } = require('./ingest-pause');

const SENDER = 'c0ffee000001';

function harness({ held = () => false, known = { [SENDER]: 'k-777' } } = {}) {
  _resetIngestPause();
  const frames = [];
  const minted = [];
  const asked = [];
  const pool = {
    query: async (sql, params) => {
      if (/FROM site\.lockdown_now/.test(sql)) return { rows: [{ ingest_paused: [], min_account_age_days: 0 }] };
      if (/FROM stream\.users u\s+LEFT JOIN stream\.links/.test(sql)) {
        return known[params[0]] === undefined ? { rows: [] } : { rows: [{ id: params[0], platform_id: known[params[0]] }] };
      }
      if (/WITH ins AS/.test(sql)) return { rows: [{ id: 1, first_msg: false }], rowCount: 1 };
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
  };
  const chat = createChat({
    pool,
    resolveOrCreate: async (...a) => { minted.push(a); return 'fresh0000001'; },
    resolveCanonical: async () => null,
    banHold: { isHeld: (...a) => { asked.push(a); return held(...a); } },
    pollEngine: { active: () => false, vote: async () => {} }, msgBuffer: [],
    broadcast: (f) => frames.push(f), bufferPush: () => {},
  });
  const routes = {};
  const reg = (method) => (p, ...h) => { routes[`${method} ${p}`] = h[h.length - 1]; };
  chat.registerChatRoutes(
    { post: reg('POST'), get: reg('GET'), patch: reg('PATCH'), delete: reg('DELETE'), put: reg('PUT') },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const release = async (over = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['POST /chat']({
      body: { platform: 'kick', userId: '', username: 'casey', message: 'held for review', releaseHold: true, canonicalId: SENDER, ...over },
      ip: '127.0.0.1',
    }, res);
    await new Promise((r) => setImmediate(r));
    return res;
  };
  return { release, frames, minted, asked };
}

test('a released hold keeps its sender\'s canonical, and a banned sender\'s release is refused', async (t) => {
  await t.test('the line is posted under the held row\'s canonical — no fresh identity', async () => {
    const h = harness();
    const res = await h.release();
    assert.equal(res.statusCode, 200);
    assert.equal(h.minted.length, 0, 'a release minted a new identity');
    const msg = h.frames.find((f) => f.type === 'message');
    assert.ok(msg, 'the released line was not broadcast');
    assert.equal(msg.canonicalId, SENDER);
    // The ban hold is asked about the real sender, by canonical and by their platform account.
    assert.deepEqual(h.asked[0], [SENDER, 'kick', 'k-777']);
  });

  await t.test('a sender banned since the hold is refused, in words, and nothing is posted', async () => {
    const h = harness({ held: (c) => c === SENDER });
    const res = await h.release();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'sender_banned');
    assert.equal(h.frames.length, 0, 'a banned sender\'s held line was published');
  });

  await t.test('a sender whose identity is gone (the account was deleted) is refused, not minted', async () => {
    const h = harness({ known: {} });
    const res = await h.release();
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'sender_gone');
    assert.equal(h.minted.length, 0);
    assert.equal(h.frames.length, 0);
  });

  await t.test('a malformed canonical is refused', async () => {
    const h = harness();
    const res = await h.release({ canonicalId: 'not-a-canonical' });
    assert.equal(res.statusCode, 400);
    assert.equal(h.frames.length, 0);
  });

  await t.test('a retry (the same release twice) and a restart (a new process) post under the same canonical', async () => {
    const a = harness();
    await a.release();
    await a.release();
    const b = harness();
    await b.release();
    const ids = [...a.frames, ...b.frames].filter((f) => f.type === 'message').map((f) => f.canonicalId);
    assert.deepEqual(ids, [SENDER, SENDER, SENDER]);
    assert.equal(a.minted.length + b.minted.length, 0);
  });

  await t.test('a canonical without releaseHold is ignored: ingest still resolves by platform id', async () => {
    const h = harness();
    await h.release({ releaseHold: undefined, userId: 'k-1' });
    assert.equal(h.minted.length, 1, 'a caller-chosen canonical was trusted outside a release');
  });
});
