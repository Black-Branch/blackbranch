// supportbar.js — the bank that must survive its own time conversion.
//
// Run: node --test supportbar.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupportBar } = require('./supportbar');
const { NATIVE_PLATFORM, isNativePlatform } = require('./native-platform');

test('F-7: earnTime throwing (a corrupt night frontier) must not escape add() — the bar was already bumped and broadcast', () => {
  // supportbar.js banks the $ and broadcasts BEFORE asking the timer for time
  // (a locked timer never costs a donation). If that call throws, the
  // enclosing money route 500s AFTER the total moved — and Ko-fi/Streamlabs
  // retry a 500, so the same dollars land twice. The read-only notional quote
  // and the mutating credit are both guarded.
  const frames = [];
  const bar = createSupportBar({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    broadcast: (f) => frames.push(f),
    getStreamId: async () => null,
    earnTime: () => { throw new Error('convertCents: frontierSec below first sellable block'); },
  });
  const origWarn = console.warn; console.warn = () => {};
  let out;
  try { out = bar.add(25, 'someone'); } finally { console.warn = origWarn; }
  assert.equal(out.total, 25, 'the bank held');
  assert.equal(out.deltaSeconds, 0, 'time degraded to nothing');
  assert.equal(frames.filter((f) => f.type === 'updateSupportBar').length, 1, 'one broadcast, no retry');
});

test('add(takeHome, username, userId): the canonical id rides the onAdd payload as a string, null when absent or empty', () => {
  const payloads = [];
  const bar = createSupportBar({
    pool: null, broadcast: () => {}, getStreamId: async () => null,
    earnTime: () => 0, onAdd: (p) => payloads.push(p),
  });
  bar.add(4.56, 'GadgetFan', 'a60500127435');
  bar.add(4.56, 'GadgetFan');
  bar.add(4.56, 'GadgetFan', '');
  assert.deepEqual(payloads.map((p) => p.userId), ['a60500127435', null, null]);
  assert.equal(payloads[0].username, 'GadgetFan', 'the donation name still travels — it becomes the alias');
});

test('init(): the per-stream re-sum excludes the currency-spend event types IN SQL', async () => {
  const seen = [];
  const bar = createSupportBar({
    pool: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ s: '12.50' }], rowCount: 1 }; } },
    broadcast: () => {}, getStreamId: async () => 'S1',
    excludeEventTypes: ['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound'],
  });
  const origLog = console.log; console.log = () => {};
  let total;
  try { total = await bar.init(); } finally { console.log = origLog; }
  assert.equal(total, 12.5);
  const q = seen.find((s) => /SUM\(COALESCE\(admitted_usd, amount_usd\)\)/.test(s.sql));
  assert.ok(q, 'init must re-sum support_events');
  // COALESCE, not a bare `event_type <> ALL(...)` — see the dedicated NULL
  // test below for why the bare form is a silent-money-drop bug, not a style
  // choice. Also platform-scoped — see the platform-scoping test below.
  assert.match(q.sql, /NOT \(platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY\(\$2::text\[\]\)\)/,
    'a fake pool sees no SQL unless you make it — the rule lives in the query');
  assert.deepEqual(q.params, ['S1', ['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound']]);
});

test('init(): nothing injected → an empty exclusion, every row counts (older callers)', async () => {
  const seen = [];
  const bar = createSupportBar({
    pool: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ s: '1.00' }], rowCount: 1 }; } },
    broadcast: () => {}, getStreamId: async () => 'S1',
  });
  const origLog = console.log; console.log = () => {};
  try { await bar.init(); } finally { console.log = origLog; }
  assert.deepEqual(seen[0].params, ['S1', []]);
});

test('init(): a NULL event_type must not be silently dropped by the exclusion', async () => {
  // event_type is nullable (schema.sql) and money.js stores a blank kind as
  // NULL (`eventType || null`). In Postgres, `NULL <> ALL(ARRAY[...])`
  // evaluates to NULL, and WHERE drops a NULL row — with no error anywhere.
  // A fake pool CANNOT catch this: the JS fold models the rule as
  // `!excluded.includes(row.event_type)`, and `undefined` is simply never IN
  // a list of strings, so an un-COALESCEd query would still pass a
  // behavioural fixture. The rule lives in the SQL text, so it has to be
  // pinned as SQL text.
  const seen = [];
  const bar = createSupportBar({
    pool: { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ s: '0' }], rowCount: 1 }; } },
    broadcast: () => {}, getStreamId: async () => 'S1',
    excludeEventTypes: ['cheer'],
  });
  const origLog = console.log; console.log = () => {};
  try { await bar.init(); } finally { console.log = origLog; }
  const q = seen.find((s) => /SUM\(COALESCE\(admitted_usd, amount_usd\)\)/.test(s.sql));
  assert.match(q.sql, /NOT \(platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY\(\$2::text\[\]\)\)/,
    'a bare `event_type <> ALL(...)` silently drops every NULL-typed row — the SQL must be NULL-tolerant');
});

test("init(): the exclusion is platform-scoped — a platform='twitch' row sharing a coin-kind event_type is KEPT in the bar total", async () => {
  // Currency spends only ever arrive under the site's own platform id (money.js). This fake
  // pool actually APPLIES the WHERE clause to fixture rows (unlike the tests
  // above, which only inspect SQL text) — safe to do here because `platform`
  // is NOT NULL in schema.sql, so unlike event_type there is no hidden
  // three-valued-logic gap a JS mirror could paper over.
  const rows = [
    { platform: 'twitch', event_type: 'cheer', amount_usd: 7 },   // real money, must be KEPT
    { platform: NATIVE_PLATFORM, event_type: 'cheer', amount_usd: 5 },   // the actual currency spend, must be excluded
    { platform: NATIVE_PLATFORM, event_type: 'donation', amount_usd: 3 }, // a real donation, must be KEPT
  ];
  const exclude = ['cheer', 'sticker', 'sticker_boost', 'tts_msg', 'sound'];
  const kept = (r) => !(isNativePlatform(r.platform) && exclude.includes(r.event_type));
  const expectedTotal = rows.filter(kept).reduce((s, r) => s + r.amount_usd, 0);
  assert.equal(expectedTotal, 10, 'sanity: twitch cheer (7) + site donation (3), site cheer (5) excluded');

  const bar = createSupportBar({
    pool: {
      query: async (sql, params) => {
        assert.match(sql, /NOT \(platform IN \('native'[^)]*\) AND COALESCE\(event_type, ''\) = ANY\(\$2::text\[\]\)\)/,
          'this test only trusts the sum it computes if the SQL text is the real predicate');
        assert.deepEqual(params, ['S1', exclude]);
        return { rows: [{ s: String(expectedTotal) }], rowCount: 1 };
      },
    },
    broadcast: () => {}, getStreamId: async () => 'S1',
    excludeEventTypes: exclude,
  });
  const origLog = console.log; console.log = () => {};
  let total;
  try { total = await bar.init(); } finally { console.log = origLog; }
  assert.equal(total, 10, "the twitch cheer must count toward the bar — only the site's own coin-spend rows are spectacle");
});
