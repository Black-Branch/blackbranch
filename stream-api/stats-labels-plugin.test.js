// The stats rebuild and the profile lookup carry NO scoring label. A label is the scoring plugin's own reading of the scores — no scorer, no labels.
// The product's part is two seams: the plugin's `afterAggregates` step, run once after every
// rebuild, and `profileExtras` on /user/lookup (owner/temperament.test.js proves the site plugin's pill
// still arrives through it; the label names and thresholds are named only there).
// Run: node --test stats-labels-plugin.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAggregates } = require('./aggregates');
const { mountLookup } = require('./testlib/profile-lookup');
const { scanSource } = require('./testlib/source');

/** A stand-in pool that records every statement and answers each with no rows. */
function recordingPool() {
  const sql = [];
  return { sql, query: async (s) => { sql.push(String(s)); return { rows: [] }; } };
}

test('the product rebuild writes no label: no temperament column, no label words in its SQL', async () => {
  const pool = recordingPool();
  await createAggregates({ pool, schedule: () => {} }).requestAggregateRefresh();
  assert.ok(pool.sql.some((s) => /INSERT INTO stream\.user_stats/.test(s)), 'the rebuild did not run');
  for (const s of pool.sql) assert.doesNotMatch(s, /temperament/i, 'a product statement still touches the label');
});

test("the plugin's step runs once, after the product's last statement, with the pool", async () => {
  const pool = recordingPool();
  const calls = [];
  const afterAggregates = async (ctx) => { calls.push({ ctx, seen: pool.sql.length }); };
  await createAggregates({ pool, schedule: () => {}, afterAggregates }).requestAggregateRefresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.pool, pool);
  assert.equal(calls[0].seen, pool.sql.length, 'the plugin step ran before a product statement');
  assert.ok(pool.sql.some((s) => /intelligence_tier/.test(s)), 'the product steps ran first');
});

test("a failing plugin step costs neither the product's stats nor the next pass", async () => {
  const pool = recordingPool();
  let runs = 0;
  const warn = console.warn; const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const agg = createAggregates({ pool, schedule: () => {}, afterAggregates: async () => { runs++; throw new Error('boom'); } });
    await agg.requestAggregateRefresh();
    await agg.requestAggregateRefresh();
  } finally { console.warn = warn; }
  assert.equal(runs, 2, 'the second pass did not run the plugin step again');
  assert.equal(pool.sql.filter((s) => /INSERT INTO stream\.user_stats/.test(s)).length, 2);
  assert.ok(warned.some((w) => /boom/.test(w)), 'the failure was swallowed silently');
});

test('without a plugin the profile lookup answers no label, rank or camp', async () => {
  const body = await mountLookup(null)({ canonicalId: 'c1' });
  assert.equal(body.name, 'ann', 'the lookup did not answer');
  for (const k of ['camp', 'temperamentLabel', 'labelRank', 'labelCount']) assert.equal(k in body, false, `${k} is still a product field`);
});

test('aggregates.js and profiles.js name no label column (source, comments stripped, read to the end)', () => {
  const agg = scanSource('aggregates.js', /module\.exports = \{ createAggregates, makeRefresher, REFRESH_MS \};\s*$/);
  const prof = scanSource('profiles.js', /module\.exports = \{ registerProfileRoutes \};\s*$/);
  for (const [name, src] of [['aggregates.js', agg], ['profiles.js', prof]]) {
    assert.doesNotMatch(src, /temperament|\b(label_rank|label_count|low_frac|high_frac)\b/i, `${name} still derives or ranks a label`);
  }
});
