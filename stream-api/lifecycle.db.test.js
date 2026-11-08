// lifecycle.js session edges against a REAL Postgres, through the pg driver (a mock pool cannot
// tell `ended_at IS NULL` from nothing, nor run the window's interval arithmetic):
//   • a second /stream/end leaves ended_at alone, recomputes nothing and fires no hook;
//   • /stream/start { resume: true } reopens a row ended inside RESUME_GRACE_MS, without the
//     start hook; outside the window, for an open row, an unknown id or a forced end it is a 409;
//   • a resumed session counts as proof of life: the heartbeat check does not close it before the
//     poller's first new snapshot.
// Fixtures: only rows whose stream_id starts with 'lv11-' are written, and they are deleted before
// and after. Point it at a THROWAWAY database only.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test lifecycle.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createLifecycle } = require('./lifecycle');
const { PLATFORM_LIVENESS } = require('./platformLiveness.generated');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';

function harness(pool) {
  const hooks = [];
  const lc = createLifecycle({
    pool, broadcast: () => {},
    onStreamStart: async (id) => { hooks.push(['start', id]); },
    onStreamEnd: async (id) => { hooks.push(['end', id]); },
  });
  const routes = {};
  lc.registerLifecycleRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const call = async (path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const origLog = console.log; console.log = () => {};
    try { await routes[path]({ body: body ?? {} }, res); } finally { console.log = origLog; }
    return res;
  };
  return { call, hooks, lc };
}

test('session edges against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => pool.query("DELETE FROM stream.sessions WHERE stream_id LIKE 'lv11-%'");
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const row = async (id) => (await pool.query(
    'SELECT ended_at, avg_message_words FROM stream.sessions WHERE stream_id = $1', [id])).rows[0];

  await t.test('retry: a second /stream/end leaves ended_at alone, recomputes nothing, fires no hook', async () => {
    const h = harness(pool);
    assert.deepEqual((await h.call('/stream/start', { streamId: 'lv11-end' })).body, { ok: true });
    assert.deepEqual((await h.call('/stream/end', { streamId: 'lv11-end' })).body, { ok: true });
    // Back-date the close and mark the avg, so a second end that wrote either would show.
    await pool.query("UPDATE stream.sessions SET ended_at = NOW() - INTERVAL '1 hour', avg_message_words = 42 WHERE stream_id = 'lv11-end'");
    const before = await row('lv11-end');
    const again = await h.call('/stream/end', { streamId: 'lv11-end' });
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.body, { ok: true, already: true });
    const after = await row('lv11-end');
    assert.equal(after.ended_at.getTime(), before.ended_at.getTime(), 'ended_at unchanged');
    assert.equal(after.avg_message_words, 42, 'no avg recompute');
    assert.deepEqual(h.hooks, [['start', 'lv11-end'], ['end', 'lv11-end']], 'one end hook, for the real end');
  });

  await t.test('a resume inside the window clears ended_at, keeps the id, and skips onStreamStart', async () => {
    const h = harness(pool);
    await h.call('/stream/start', { streamId: 'lv11-resume' });
    await h.call('/stream/end', { streamId: 'lv11-resume' });
    await pool.query("UPDATE stream.sessions SET ended_at = NOW() - INTERVAL '2 minutes' WHERE stream_id = 'lv11-resume'");
    const res = await h.call('/stream/start', { streamId: 'lv11-resume', resume: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { ok: true, resumed: true });
    assert.equal((await row('lv11-resume')).ended_at, null, 'the same session is open again');
    assert.deepEqual(h.hooks, [['start', 'lv11-resume'], ['end', 'lv11-resume']], 'no second start hook');
    // The reopened session ends like any other: a real end, with its hook.
    assert.deepEqual((await h.call('/stream/end', { streamId: 'lv11-resume' })).body, { ok: true });
    assert.notEqual((await row('lv11-resume')).ended_at, null);
  });

  await t.test('a resumed session is proof of life: liveState() with an old started_at and no new heartbeat keeps it open', async () => {
    // liveState() reads the NEWEST open session, and other test files hold open sessions of their
    // own while they run. So this runs on one connection in a REPEATABLE READ transaction that
    // closes every other open session first (row locks, rolled back at the end): liveState() then
    // sees this session only, and nothing outside the transaction ever sees the change.
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query("UPDATE stream.sessions SET ended_at = NOW() WHERE ended_at IS NULL AND stream_id <> 'lv11-heal'");
      await c.query("INSERT INTO stream.sessions (stream_id, started_at, ended_at) VALUES ('lv11-heal', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 minutes')");
      // Its last heartbeat is from before the drop: 12 minutes old.
      await c.query("INSERT INTO stream.viewer_snapshots (stream_id, twitch, recorded_at) VALUES ('lv11-heal', 7, NOW() - INTERVAL '12 minutes')");
      const h = harness({ query: (sql, params) => c.query(sql, params) });
      const res = await h.call('/stream/start', { streamId: 'lv11-heal', resume: true });
      assert.deepEqual(res.body, { ok: true, resumed: true });
      const s = await h.lc.liveState();
      assert.equal(s.live, true, 'not self-healed closed before the first new snapshot');
      assert.equal(s.streamId, 'lv11-heal');
      const { rows } = await c.query("SELECT ended_at FROM stream.sessions WHERE stream_id = 'lv11-heal'");
      assert.equal(rows[0].ended_at, null);
      assert.deepEqual(h.hooks, [], 'no end hook fired');

      // The control: a fresh process (no resume seen) heals the same row — the grace above is the resume's.
      const fresh = harness({ query: (sql, params) => c.query(sql, params) });
      assert.equal((await fresh.lc.liveState()).live, false);
      assert.deepEqual(fresh.hooks, [['end', 'lv11-heal']]);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  await t.test('outside the window → 409, and the row stays closed', async () => {
    const h = harness(pool);
    await h.call('/stream/start', { streamId: 'lv11-late' });
    const pastMs = PLATFORM_LIVENESS.RESUME_GRACE_MS + 60_000;
    await pool.query("UPDATE stream.sessions SET ended_at = NOW() - ($2::int * INTERVAL '1 millisecond') WHERE stream_id = $1", ['lv11-late', pastMs]);
    const before = await row('lv11-late');
    const res = await h.call('/stream/start', { streamId: 'lv11-late', resume: true });
    assert.equal(res.statusCode, 409);
    assert.equal((await row('lv11-late')).ended_at.getTime(), before.ended_at.getTime());
  });

  await t.test('an open row, or an id that never existed, is not resumable (409, nothing inserted)', async () => {
    const h = harness(pool);
    await h.call('/stream/start', { streamId: 'lv11-open' });
    assert.equal((await h.call('/stream/start', { streamId: 'lv11-open', resume: true })).statusCode, 409);
    assert.equal((await h.call('/stream/start', { streamId: 'lv11-nobody', resume: true })).statusCode, 409);
    assert.equal(await row('lv11-nobody'), undefined, 'a resume never creates a row');
  });

  await t.test('a forced end never resumes, even inside the window', async () => {
    const h = harness(pool);
    await h.call('/stream/start', { streamId: 'lv11-forced' });
    await h.call('/stream/end', { streamId: 'lv11-forced', forced: true, by: '@mod:site.test' });
    const res = await h.call('/stream/start', { streamId: 'lv11-forced', resume: true });
    assert.equal(res.statusCode, 409);
    assert.notEqual((await row('lv11-forced')).ended_at, null, 'still closed');
  });
});
