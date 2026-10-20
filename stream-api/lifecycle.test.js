// lifecycle.js — the stream-start hook.
//
// Run: node --test lifecycle.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLifecycle } = require('./lifecycle');

function harness(onStreamStart) {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  const lc = createLifecycle({ pool, broadcast: () => {}, onStreamStart });
  const routes = {};
  lc.registerLifecycleRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path]({ body }, res);
    return res;
  };
  return { post, queries };
}

test('/stream/start fires onStreamStart AFTER the session row is written, with the stream id', async () => {
  const order = [];
  const h = harness(async (id) => { order.push(['hook', id, h.queries.length]); });
  const res = await h.post('/stream/start', { streamId: 4242 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(order, [['hook', 4242, 1]], 'called once, after the INSERT');
});

test('a hook that throws does not fail the route', async () => {
  const h = harness(async () => { throw new Error('pool rebuild blew up'); });
  const origWarn = console.warn; console.warn = () => {};
  let res;
  try { res = await h.post('/stream/start', { streamId: 1 }); } finally { console.warn = origWarn; }
  assert.equal(res.statusCode, 200);
});

test('no hook: the route is exactly what it was', async () => {
  const h = harness(null);
  const res = await h.post('/stream/start', { streamId: 1 });
  assert.equal(res.statusCode, 200);
  assert.equal(h.queries.length, 1);
});

// ── the live YouTube broadcast id through the seam ──

const VALID_ID = 'dQw4w9WgXcQ';
const sessionUpdate = (h) => h.queries.find((q) => /UPDATE stream\.sessions SET yt_video_id/.test(q.sql));

test('a snapshot carrying a well-formed id writes it onto the open session', async () => {
  const h = harness(null);
  const res = await h.post('/viewer-snapshot', { streamId: 's1', twitch: 4, ytVideoId: VALID_ID });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sessionUpdate(h)?.params, ['s1', VALID_ID]);
  assert.equal(h.queries.length, 2, 'the snapshot INSERT and the session UPDATE, nothing else');
});

test('the id is validated at the trust boundary: junk, "", or absent → NULL (the site then falls back to the channel form)', async () => {
  for (const bad of [undefined, '', 'not-an-id', 'dQw4w9WgXcQ<script>', 12345]) {
    const h = harness(null);
    await h.post('/viewer-snapshot', { streamId: 's1', ytVideoId: bad });
    assert.deepEqual(sessionUpdate(h)?.params, ['s1', null], `ytVideoId=${JSON.stringify(bad)}`);
  }
});

test('/stream/current returns the stored id while live, null when the column is empty', async () => {
  for (const stored of [VALID_ID, null]) {
    const pool = {
      query: async (sql) => {
        if (/FROM stream\.sessions/.test(sql)) return { rows: [{ stream_id: 's1', started_at: new Date(), yt_video_id: stored }] };
        if (/FROM stream\.viewer_snapshots/.test(sql)) return { rows: [{ twitch: 1, youtube: 1, kick: null, streamplace: null, total: 2, fresh: true }] };
        return { rows: [], rowCount: 1 };
      },
    };
    const lc = createLifecycle({ pool, broadcast: () => {}, onStreamStart: null });
    const state = await lc.liveState();
    assert.equal(state.live, true);
    assert.equal(state.ytVideoId, stored, 'the id the row holds is the id the site gets');
  }
});

test('the session SELECT asks for yt_video_id — a column the row must carry or the field is silently undefined', async () => {
  const seen = [];
  const pool = { query: async (sql) => { seen.push(sql); return { rows: [] }; } };
  await createLifecycle({ pool, broadcast: () => {} }).liveState();
  assert.match(seen[0], /SELECT stream_id, started_at, yt_video_id FROM stream\.sessions/);
});

// ── A mod's "force offline" must not be undone by the very next poller tick ──
// A mod ends the session as one platform drops while others still report live;
// without memory of that, the poller opens a SECOND session seconds later (a
// phantom stream, and the credit pool re-keys tonight's supporters as "last
// stream's cohort" early). The forced end is remembered and reported on
// /stream/current, so the poller can hold until every platform has confirmed
// offline.
function forcedHarness(now) {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; } };
  const lc = createLifecycle({ pool, broadcast: () => {}, now });
  const routes = {};
  lc.registerLifecycleRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path]({ body: body ?? {} }, res);
    return res;
  };
  return { call, queries };
}

test('a forced end is reported on /stream/current — without who forced it; a plain end is not', async () => {
  let t = 1_000_000;
  const h = forcedHarness(() => t);
  await h.call('/stream/end', { streamId: 's1', forced: true, by: '@mod:site.test' });
  let cur = await h.call('/stream/current');
  assert.equal(cur.body.live, false);
  assert.equal(cur.body.forcedEndAt, 1_000_000);
  assert.equal(cur.body.forcedBy, undefined,
    'the public /stream/current named the mod who forced the stream offline — the journal line at /stream/end is where that belongs');

  const plain = forcedHarness(() => t);
  await plain.call('/stream/end', { streamId: 's1' });
  cur = await plain.call('/stream/current');
  assert.equal(cur.body.forcedEndAt, undefined, 'an ordinary poller end carries no hold');
});

test('the forced end expires after fifteen minutes and is cleared by a new session', async () => {
  let t = 1_000_000;
  const h = forcedHarness(() => t);
  await h.call('/stream/end', { streamId: 's1', forced: true, by: '@mod:site.test' });
  t += 15 * 60 * 1000 - 1;
  let cur = await h.call('/stream/current');
  assert.equal(cur.body.forcedEndAt, 1_000_000, 'still held inside the window');
  t += 2;
  cur = await h.call('/stream/current');
  assert.equal(cur.body.forcedEndAt, undefined, 'a press by mistake, or an earlier stream, must not hold the next one');

  const h2 = forcedHarness(() => t);
  await h2.call('/stream/end', { streamId: 's1', forced: true, by: '@mod:site.test' });
  await h2.call('/stream/start', { streamId: 's2' });
  cur = await h2.call('/stream/current');
  assert.equal(cur.body.forcedEndAt, undefined, 'a started session ends the hold');
});

// ── the stream-END hook (e.g. a forced-on Gadget goes back to auto) ──

function endHarness({ onStreamEnd, rowsFor }) {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: rowsFor ? rowsFor(sql) : [], rowCount: 1 }; } };
  const lc = createLifecycle({ pool, broadcast: () => {}, onStreamEnd });
  const routes = {};
  lc.registerLifecycleRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path]({ body }, res);
    return res;
  };
  return { lc, post, queries };
}

test('/stream/end fires onStreamEnd after the session is closed, with the stream id', async () => {
  const seen = [];
  const h = endHarness({ onStreamEnd: async (id) => { seen.push([id, h.queries.some((q) => /SET ended_at = NOW\(\)/.test(q.sql))]); } });
  const origLog = console.log; console.log = () => {};
  let res;
  try { res = await h.post('/stream/end', { streamId: 77 }); } finally { console.log = origLog; }
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(seen, [[77, true]]);
});

test('an end hook that throws does not fail the route', async () => {
  const h = endHarness({ onStreamEnd: async () => { throw new Error('boom'); } });
  const origLog = console.log, origWarn = console.warn; console.log = () => {}; console.warn = () => {};
  let res;
  try { res = await h.post('/stream/end', { streamId: 1 }); } finally { console.log = origLog; console.warn = origWarn; }
  assert.deepEqual(res.body, { ok: true });
});

test('the SELF-HEAL end fires it too — a stream that dies without /stream/end is still a stream ending', async () => {
  const seen = [];
  const long_ago = new Date(Date.now() - 6 * 3600_000).toISOString();
  const h = endHarness({
    onStreamEnd: async (id) => { seen.push(id); },
    rowsFor: (sql) => (/FROM stream\.sessions/.test(sql) && /ended_at IS NULL/.test(sql) && !/UPDATE/.test(sql)
      ? [{ stream_id: 55, started_at: long_ago, yt_video_id: null }] : []),
  });
  const s = await h.lc.liveState();
  assert.equal(s.live, false);
  assert.deepEqual(seen, [55]);
});
