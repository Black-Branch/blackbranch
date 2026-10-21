// Tests for the aggregate-refresh single-flight + coalesce policy.
//
// refreshAggregates is a six-statement full rebuild over stream.chat_log.
// Without an in-flight guard a pass slower than REFRESH_MS stacks on itself, and
// every identity merge detaches another copy, so a burst of merges launches many
// concurrent full rebuilds against the pool the live /chat INSERT path shares —
// stalling chat mid-stream.
//
// Coalescing rather than plain dropping is the point: a merge landing DURING a
// run must still end up reflected, so a mid-flight request schedules exactly one
// more pass. N requests collapse to at most 2 runs.
//
// Run: node --test aggregate-refresh.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// The REAL shipped policy, imported from aggregates.js — no mirrored copy to drift.
const { makeRefresher, createAggregates, REFRESH_MS } = require('./aggregates');

function gatedWork() {
  let runs = 0;
  const releases = [];
  return {
    get runs() { return runs; },
    work: () => { runs++; return new Promise((r) => releases.push(r)); },
    releaseAll: async () => {
      while (releases.length) releases.shift()();
      // let the .finally chains (and any queued follow-up) settle
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

test('THE FIX: 30 concurrent requests collapse to at most 2 runs', async () => {
  // The /identity/backfill scenario. Was ~30 concurrent full rebuilds.
  const g = gatedWork();
  const request = makeRefresher(g.work);
  for (let i = 0; i < 30; i++) request();
  assert.equal(g.runs, 1, 'only one rebuild is running at a time');
  await g.releaseAll();
  assert.equal(g.runs, 2, 'exactly one follow-up pass covers everything that arrived mid-flight');
});

test('a request arriving mid-flight is NOT lost — it gets a follow-up pass', async () => {
  // Dropping instead of coalescing would silently discard a merge's data until
  // the next 2-minute tick.
  const g = gatedWork();
  const request = makeRefresher(g.work);
  request();
  assert.equal(g.runs, 1);
  request();                       // lands during the run
  await g.releaseAll();
  assert.equal(g.runs, 2);
});

test('sequential requests each run — coalescing only applies while in flight', async () => {
  const g = gatedWork();
  const request = makeRefresher(g.work);
  request();
  await g.releaseAll();
  assert.equal(g.runs, 1);
  request();
  await g.releaseAll();
  assert.equal(g.runs, 2);
});

test('the follow-up pass does not itself trigger another (no runaway loop)', async () => {
  const g = gatedWork();
  const request = makeRefresher(g.work);
  request(); request(); request();
  await g.releaseAll();
  assert.equal(g.runs, 2, 'settles at 2, does not keep re-arming');
});

test('a FAILING run still clears the in-flight slot', async () => {
  // Otherwise one error wedges aggregates forever — nothing would ever refresh
  // again, silently, until a restart.
  let runs = 0;
  let boom = true;
  const request = makeRefresher(async () => {
    runs++;
    if (boom) throw new Error('db down');
  });
  await request();
  assert.equal(runs, 1);
  boom = false;
  await request();
  assert.equal(runs, 2, 'the refresher recovered after a failure');
});

test('a failure mid-flight still honours a queued request', async () => {
  let runs = 0;
  const releases = [];
  const request = makeRefresher(() => {
    runs++;
    return new Promise((_, rej) => releases.push(rej));
  });
  request();
  request();                       // queued behind the failing one
  while (releases.length) releases.shift()(new Error('nope'));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(runs, 2, 'the queued pass runs even though the first threw');
});

// ── the shipped wiring must carry this ───────────────────────────────────────

test('start() drives the WRAPPER on the interval, never the raw rebuild', async () => {
  // If the interval ever calls the raw six-statement rebuild directly, slow
  // passes stack — the exact M32 failure. Pin that the scheduled function IS
  // requestAggregateRefresh (identity, not name), and that start() also kicks
  // one immediate pass.
  const queries = [];
  const pool = { query: async (sql) => { queries.push(String(sql)); return { rows: [] }; } };
  const scheduled = [];
  const agg = createAggregates({ pool, schedule: (fn, ms) => { scheduled.push({ fn, ms }); } });

  agg.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, REFRESH_MS);
  assert.equal(scheduled[0].fn, agg.pollAggregateRefresh,
    'the interval is not driving the coalescing wrapper — passes would stack');

  // The startup kick went through the same wrapper and actually ran the rebuild
  // (first pass after a restart has no watermark, so it always rebuilds).
  await agg.pollAggregateRefresh();
  assert.ok(queries.length >= 7, `expected watermark probe + six-statement rebuild, saw ${queries.length} queries`);
  assert.ok(queries.some((q) => /INSERT INTO stream\.user_stats/.test(q)),
    'the rebuild itself never ran');
});

// (The "mergeCanonicals goes through requestAggregateRefresh, coalesced" wiring
// check is a behavioral spy assertion in identity-merge.test.js.)

// ── Dirty-flag: quiet box, quiet rebuild ────────────────────────────────────
// A pass is expensive and runs around the clock on the box that serves live
// chat, while chat_log is silent most of the day. The rebuild's inputs are append-only
// (chat_log, support_events), so a MAX(id) watermark pair is a complete change
// detector for INSERTs — with two deliberate exceptions:
//   • late karma/intelligence UPDATEs land on existing rows AFTER the last
//     insert → ONE settle pass runs after the watermark stops moving;
//   • identity merges rewrite user_id IN PLACE (no new ids) → the merge path
//     calls the FORCING entry, which bypasses the watermark.

function watermarkPool(state) {
  // Answers the watermark probe from `state.wm`; records everything else.
  const rebuilds = [];
  return {
    rebuilds,
    query: async (sql) => {
      const s = String(sql);
      if (/MAX\(id\)/.test(s)) return { rows: [{ c: state.wm, s: '0' }] };
      if (/INSERT INTO stream\.user_stats/.test(s)) rebuilds.push(s);
      return { rows: [] };
    },
  };
}

test('an unchanged watermark gets ONE settle pass, then the rebuild goes quiet', async () => {
  const state = { wm: '100' };
  const pool = watermarkPool(state);
  const agg = createAggregates({ pool, schedule: () => {} });
  await agg.pollAggregateRefresh();          // first pass: no watermark yet
  assert.equal(pool.rebuilds.length, 1);
  await agg.pollAggregateRefresh();          // settle: late score UPDATEs
  assert.equal(pool.rebuilds.length, 2);
  await agg.pollAggregateRefresh();          // quiet box
  await agg.pollAggregateRefresh();
  assert.equal(pool.rebuilds.length, 2,
    'the full rebuild ran against an unchanged chat_log — the 20h-quiet box pays ~600 no-op passes/day');
});

test('new chat rows re-arm the rebuild', async () => {
  const state = { wm: '100' };
  const pool = watermarkPool(state);
  const agg = createAggregates({ pool, schedule: () => {} });
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();          // quiet
  assert.equal(pool.rebuilds.length, 2);
  state.wm = '101';                          // a message arrived
  await agg.pollAggregateRefresh();
  assert.equal(pool.rebuilds.length, 3, 'a new chat_log row did not re-arm the rebuild');
});

test('a merge FORCES a rebuild even though it adds no rows', async () => {
  // mergeCanonicals rewrites chat_log.user_id in place — the watermark cannot
  // see it. identity.js calls requestAggregateRefresh (the forcing entry).
  const state = { wm: '100' };
  const pool = watermarkPool(state);
  const agg = createAggregates({ pool, schedule: () => {} });
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();          // quiet
  assert.equal(pool.rebuilds.length, 2);
  await agg.requestAggregateRefresh();       // merge path
  assert.equal(pool.rebuilds.length, 3, 'a merge was invisible to the watermark and got skipped');
});

test('a failed rebuild does not advance the watermark — the next poll retries', async () => {
  const state = { wm: '100' };
  let boom = false;
  const rebuilds = [];
  const pool = {
    query: async (sql) => {
      const s = String(sql);
      if (/MAX\(id\)/.test(s)) return { rows: [{ c: state.wm, s: '0' }] };
      if (/INSERT INTO stream\.user_stats/.test(s)) {
        rebuilds.push(s);
        if (boom) throw new Error('db blip');
      }
      return { rows: [] };
    },
  };
  const agg = createAggregates({ pool, schedule: () => {} });
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();
  await agg.pollAggregateRefresh();          // quiet at 2
  state.wm = '101';
  boom = true;
  await agg.pollAggregateRefresh();          // fails mid-rebuild
  assert.equal(rebuilds.length, 3);
  boom = false;
  await agg.pollAggregateRefresh();
  assert.equal(rebuilds.length, 4, 'the failed pass was recorded as done — its data is lost until the next message');
});

test('the user_stats rebuild excludes the currency-spend event types from lifetime support', async () => {
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql: String(sql), params });
      if (/MAX\(id\)/.test(String(sql))) return { rows: [{ c: '1', s: '1' }] };
      return { rows: [] };
    },
  };
  const agg = createAggregates({ pool, schedule: () => {}, excludeEventTypes: ['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound'] });
  await agg.pollAggregateRefresh();
  const q = seen.find((s) => /INSERT INTO stream\.user_stats/.test(s.sql));
  assert.ok(q, 'the rebuild ran');
  // COALESCE, not a bare `event_type <> ALL(...)` — see the dedicated NULL
  // test below for why the bare form is a silent-money-drop bug. Also
  // platform-scoped: the site-platform test must gate the exclusion, or an
  // external platform's row sharing a coin-kind event_type string would be
  // wrongly dropped from lifetime support — see the platform-scoping test
  // below, and sponsors.test.js's behavioural version of the same property
  // (the predicate is syntactically identical in both modules).
  assert.match(q.sql, /FROM stream\.support_events[\s\S]*?WHERE NOT \(platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY\(\$1::text\[\]\)\)\s+GROUP BY user_id/,
    'the lifetime-support fold must exclude spend kinds IN SQL, NULL-tolerantly and platform-scoped to the site');
  assert.deepEqual(q.params, [['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound']]);
});

test('the user_stats rebuild must not silently drop a NULL event_type from lifetime support', async () => {
  // event_type is nullable (schema.sql) and money.js stores a blank kind as
  // NULL. In Postgres, `NULL <> ALL(ARRAY[...])` evaluates to NULL, and WHERE
  // drops a NULL row — silently, with no error. A fake pool cannot catch
  // this: this test's own fixture only inspects the SQL TEXT and never
  // simulates three-valued logic, because a fixture that DID model it as
  // `!excluded.includes(row.event_type)` would treat `undefined` as simply
  // never being in the excluded list and pass either way. The rule lives in
  // the SQL, so it must be pinned as SQL text.
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql: String(sql), params });
      if (/MAX\(id\)/.test(String(sql))) return { rows: [{ c: '1', s: '1' }] };
      return { rows: [] };
    },
  };
  const agg = createAggregates({ pool, schedule: () => {}, excludeEventTypes: ['cheer'] });
  await agg.pollAggregateRefresh();
  const q = seen.find((s) => /INSERT INTO stream\.user_stats/.test(s.sql));
  assert.match(q.sql, /WHERE NOT \(platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY\(\$1::text\[\]\)\)/,
    'a bare `event_type <> ALL(...)` silently drops every NULL-typed row — the SQL must be NULL-tolerant');
});

test("the lifetime-support fold is platform-scoped: a platform='twitch' row sharing a coin-kind event_type is NOT excluded", async () => {
  // Currency spends only ever arrive under the site's own platform id (money.js). The
  // predicate must say so explicitly — `platform IN (…) AND` — or an
  // external platform's real donation that happens to carry
  // event_type='cheer' (stream-ingest/lib/alerts.js already emits
  // `eventType: 'bits'`/'cheered' for Twitch) would be silently dropped from
  // every user's lifetime support on the next rebuild. Pinned here as SQL
  // text for the same reason the NULL test above is: this fake pool answers
  // every support_events query with a fixed `{ rows: [] }` regardless of the
  // WHERE clause, so it cannot itself distinguish "excluded" from "kept" —
  // see sponsors.test.js's behavioural version of this exact predicate
  // (syntactically identical) for a fixture that DOES apply the filter to
  // real rows and prove the twitch row is kept.
  const seen = [];
  const pool = {
    query: async (sql, params) => {
      seen.push({ sql: String(sql), params });
      if (/MAX\(id\)/.test(String(sql))) return { rows: [{ c: '1', s: '1' }] };
      return { rows: [] };
    },
  };
  const agg = createAggregates({ pool, schedule: () => {}, excludeEventTypes: ['cheer'] });
  await agg.pollAggregateRefresh();
  const q = seen.find((s) => /INSERT INTO stream\.user_stats/.test(s.sql));
  assert.match(q.sql, /platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY/,
    "the exclusion must gate on the site's own platform — a bare event_type match would also exclude a real donation from another platform");
  assert.doesNotMatch(q.sql, /WHERE COALESCE\(event_type, ''\) <> ALL\(\$1::text\[\]\)\s+GROUP BY user_id/,
    'the old platform-blind form must be gone, not merely joined by the new one');
});

// ── [Threshold] Low karma: once per CHANGE, not once per pass ─────────────────
//
// The 09-13 night: 6,225 identical "[Threshold] Low karma:" lines — 21 names ×
// every refresh pass (the 2-minute interval plus a forced pass per identity
// merge). A canary that prints the same fact 290 times a night is one nobody
// reads; the line is worth printing when a user first crosses the threshold or
// their printed value moves, and again if they climb out and fall back in.

test('[Threshold] Low karma prints once per user per change, not once per pass', async () => {
  const kate = { user_id: 'u1', name: 'kate', karma: '0.300', scored: '12' };
  const ruddy = { user_id: 'u2', name: 'ruddy', karma: '0.100', scored: '7' };
  const state = { rows: [kate, ruddy] };
  const pool = {
    query: async (sql) => (/us\.karma < 0\.35/.test(String(sql)) ? { rows: state.rows } : { rows: [] }),
  };
  const agg = createAggregates({ pool, schedule: () => {} });
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { const line = a.join(' '); if (line.startsWith('[Threshold] Low karma')) lines.push(line); };
  try {
    await agg.requestAggregateRefresh();
    await agg.requestAggregateRefresh();
    await agg.requestAggregateRefresh();
    assert.equal(lines.length, 2, 'one line per user on the first pass, none on two identical passes');
    assert.match(lines[0], /u1 karma=0\.300 scored=12/);
    assert.match(lines[1], /u2 karma=0\.100 scored=7/);
    assert.ok(!lines.some((l) => /kate|ruddy/.test(l)), `a person's name reached the journal: ${lines.join(' | ')}`);

    // A moved value prints again — for that user only.
    state.rows = [{ ...kate, karma: '0.250' }, ruddy];
    await agg.requestAggregateRefresh();
    assert.equal(lines.length, 3);
    assert.match(lines[2], /u1 karma=0\.250/);

    // A move invisible at the printed precision is not a change.
    state.rows = [{ ...kate, karma: '0.2504' }, ruddy];
    await agg.requestAggregateRefresh();
    assert.equal(lines.length, 3, 'a fourth-decimal wobble must not print');

    // Climbing out prints nothing; falling back in prints again.
    state.rows = [{ ...kate, karma: '0.250' }];
    await agg.requestAggregateRefresh();
    assert.equal(lines.length, 3, 'leaving the threshold is not a low-karma line');
    state.rows = [{ ...kate, karma: '0.250' }, ruddy];
    await agg.requestAggregateRefresh();
    assert.equal(lines.length, 4, 'a user who fell back under the threshold is news again');
    assert.match(lines[3], /u2 karma=0\.100/);
  } finally {
    console.log = realLog;
  }
});

// ── shutdown: stop() before pool.end() ───────────────────────────────────────
// If the drain ends the pool while a pass (or the interval's next one) is still issuing statements,
// every stop logs "[aggregates] refresh failed: Cannot use a pool after calling end on the pool".
// index.js awaits stop() first.

test('stop() waits for the running pass, then nothing more runs — not a queued follow-up, not a new request', async () => {
  const g = gatedWork();
  const request = makeRefresher(g.work);
  request();
  request(); // queued follow-up
  let stopped = false;
  const done = request.stop().then(() => { stopped = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(stopped, false, 'stop() resolved while a pass was still running — the pool would end under it');
  await g.releaseAll();
  await done;
  assert.equal(stopped, true);
  assert.equal(g.runs, 1, 'the queued follow-up ran after stop()');
  await request();
  assert.equal(g.runs, 1, 'a request after stop() started a pass');
});

test('stop() with nothing running resolves at once', async () => {
  const g = gatedWork();
  const request = makeRefresher(g.work);
  await request.stop();
  assert.equal(g.runs, 0);
});

test('stop() mid-pass waits for ONE statement, not the rest of the rebuild — and the cut pass logs nothing', async () => {
  // On a big chat_log a pass is many slow statements; a drain that waited for all of them would
  // run past the grace. The statement running finishes; the next is refused, quietly.
  const issued = [];
  let releaseCurrent = null;
  const pool = { query: (sql) => { issued.push(String(sql)); return new Promise((r) => { releaseCurrent = () => r({ rows: [] }); }); } };
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const agg = createAggregates({ pool, schedule: () => null, cancel: () => {} });
    const pass = agg.requestAggregateRefresh();
    await new Promise((r) => setImmediate(r));
    assert.equal(issued.length, 1, 'premise: the first statement (the watermark read) is running');
    let stopped = false;
    const done = agg.stop().then(() => { stopped = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(stopped, false, 'stop() did not wait for the running statement');
    releaseCurrent();
    await done;
    await pass;
    assert.equal(issued.length, 1, `the rebuild went on after stop(): ${issued.length} statements`);
    assert.deepEqual(warned, [], 'the cut pass was logged as a failure');
  } finally {
    console.warn = realWarn;
  }
});

test('createAggregates().stop() cancels the interval it scheduled, and a later tick or forced refresh issues no query', async () => {
  const queries = [];
  const pool = { query: async (sql) => { queries.push(String(sql)); return { rows: [] }; } };
  const cancelled = [];
  const agg = createAggregates({ pool, schedule: () => 'handle-1', cancel: (h) => cancelled.push(h) });
  agg.start();
  await agg.stop();
  assert.deepEqual(cancelled, ['handle-1'], 'the interval was not cancelled');
  const before = queries.length;
  assert.ok(before >= 1, 'premise: the startup pass ran before stop()');
  await agg.pollAggregateRefresh();
  await agg.requestAggregateRefresh();
  assert.equal(queries.length, before, 'a pass ran after stop() — against a pool the drain is about to end');
});
