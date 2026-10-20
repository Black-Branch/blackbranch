// Unit tests for timer.js duration parsing + command broadcasts.
// Run: node --test timer.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDuration, createTimer } = require('./timer');

test('parseDuration', () => {
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('2h3m14s'), 7394);
  assert.equal(parseDuration('90'), 90);   // bare number → seconds
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(undefined), 0);
});

test('timer state broadcasts (server-authoritative)', () => {
  const sent = [];
  // No pool → in-memory defaults (3h base = 10800s, cap 8h, $40/hr, $200 fill).
  const t = createTimer({ broadcast: (m) => sent.push(m), obs: null, pool: null });

  // adjust returns the applied (signed) seconds and broadcasts a full timerState.
  assert.equal(t.adjust('5m', 1), 300);
  assert.equal(sent.at(-1).type, 'timerState');
  assert.equal(sent.at(-1).remainingSec, 11100);
  assert.equal(sent.at(-1).deltaSec, 300);

  assert.equal(t.adjust('5m', -1), -300);        // !s
  assert.equal(sent.at(-1).remainingSec, 10800);

  assert.equal(t.set('2h'), 7200);
  assert.equal(sent.at(-1).remainingSec, 7200);

  assert.equal(t.control('pause'), true);
  assert.equal(sent.at(-1).running, false);

  assert.equal(t.control('bogus'), false);       // invalid action → no broadcast
  assert.equal(t.adjust('nonsense', 1), 0);      // unparseable → no broadcast
});

test('timer cap + config (marathon)', () => {
  const sent = [];
  const t = createTimer({ broadcast: (m) => sent.push(m), obs: null, pool: null });

  t.set('7h');                                   // clamped to the 8h cap → 7h ok
  assert.equal(sent.at(-1).remainingSec, 25200);
  t.set('10h');                                  // over 8h cap → clamped to 28800
  assert.equal(sent.at(-1).remainingSec, 28800);

  t.setConfig({ cap: 'off' });                   // marathon: no ceiling
  assert.equal(sent.at(-1).capEnabled, false);
  t.set('10h');                                  // now allowed past the old cap
  assert.equal(sent.at(-1).remainingSec, 36000);

  const cfg = t.setConfig({ hr: 24, fill: 240 }); // $24/hr, $240 fill = 10 segments
  assert.equal(cfg.usdPerHour, 24);
  assert.equal(cfg.fillUsd, 240);

  // money → time at the new rate: $24 = 1h = 3600s.
  const before = sent.at(-1).remainingSec;
  const added = t.addMoney(24);
  assert.equal(added, 3600);
  assert.equal(sent.at(-1).remainingSec, before + 3600);
});

// ── Effects config, the derived lock, and the zero floor ────────────────────

test('snapshot carries the effects config and a derived locked flag', () => {
  const sent = [];
  const t = createTimer({ broadcast: (m) => sent.push(m), obs: null, pool: null });

  const s = t.snapshot();
  assert.equal(s.lockAtZero, false, 'defaults to unlocked');
  assert.equal(s.lowPulseEnabled, true);
  assert.equal(s.lowThresholdSec, 300);
  assert.equal(s.lowRampRate, 1.6);
  assert.equal(s.lowGlowMax, 0.55);
  assert.equal(s.locked, false, 'not at cap, not at zero');
});

test('locked is derived from the CAP ceiling', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.set('8h'); // default cap is 8h (28800)
  assert.equal(t.snapshot().locked, true, 'at cap = locked');
});

test('lock at zero refuses ADDED time but never blocks subtraction', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ lockAtZero: true });
  t.set('10s');
  t.adjust('10s', -1);
  assert.equal(Math.round(t.snapshot().remainingSec), 0);
  assert.equal(t.snapshot().locked, true, 'floor lock engaged');

  assert.equal(t.adjust('1h', 1), 0, 'manual add refused while locked');
  assert.equal(t.addMoney(100), 0, 'donation adds no time while locked');
  assert.equal(Math.round(t.snapshot().remainingSec), 0);
});

test('unlocking grants grace retroactively (the rule is live, not sticky)', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ lockAtZero: true });
  t.set('10s');
  t.adjust('10s', -1);
  assert.equal(t.addMoney(40), 0, 'refused while locked');

  t.setConfig({ lockAtZero: false });
  assert.ok(t.addMoney(40) > 0, 'same donation now buys time');
});

test('lock at zero does nothing while time remains', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ lockAtZero: true });
  t.set('1h');
  assert.equal(t.adjust('5m', 1), 300, 'above zero is unaffected');
});

test('setConfig accepts the new knobs and refuses out-of-range values', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });

  const cfg = t.setConfig({
    baseSec: 7200, lockAtZero: true, lowPulseEnabled: false,
    lowThresholdSec: 600, lowRampRate: 2.4, lowGlowMax: 0.8,
  });
  assert.equal(cfg.lockAtZero, true);
  assert.equal(cfg.lowPulseEnabled, false);
  assert.equal(cfg.lowThresholdSec, 600);
  assert.equal(cfg.lowRampRate, 2.4);
  assert.equal(cfg.lowGlowMax, 0.8);
  t.reset();
  assert.equal(Math.round(t.snapshot().remainingSec), 7200, 'baseSec is the reset target');

  const after = t.setConfig({ lowGlowMax: 5, lowRampRate: -1, lowThresholdSec: 0 });
  assert.equal(after.lowGlowMax, 0.8, 'out-of-range glow max refused');
  assert.equal(after.lowRampRate, 2.4, 'negative ramp refused');
  assert.equal(after.lowThresholdSec, 600, 'zero threshold refused');
});

// ── A unit-less cap ──────────────────────────────────────────────────────────
// A bare "10" in the cap field means hours to whoever typed it, but
// parseDuration reads it as 10 seconds, and every donation's add would then be
// clamped down to 10s. A unit-less cap is ambiguous, so it is refused — and the
// refusal is reported (cfg.refused), so the panel cannot toast "Cap updated."
// over a silent no-op.
test('setConfig refuses a unit-less cap duration and reports the refusal', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const before = t.config();

  const cfg = t.setConfig({ cap: '10' });          // ambiguous: 10 what?
  assert.equal(cfg.capSec, before.capSec, 'bare-number cap does not apply');
  assert.equal(cfg.capEnabled, before.capEnabled);
  assert.deepEqual(cfg.refused, ['cap']);

  assert.equal(t.setConfig({ cap: '10h' }).capSec, 36000, 'explicit unit applies');
  assert.equal(t.setConfig({ cap: ' 45m ' }).capSec, 2700);
  assert.equal(t.setConfig({ cap: 'off' }).capEnabled, false);
  assert.equal(t.setConfig({ cap: 'on' }).capEnabled, true);
  assert.equal(t.setConfig({ cap: '8h' }).refused, undefined, 'no refusal field on success');
});

// ── barTotal on the snapshot (the site's support bar) ───────────────────────
// The web reads the running bar total off the timerState HEARTBEAT, because
// `updateSupportBar` only fires on a contribution — a viewer loading mid-stream
// would otherwise see an empty bar until someone donated. These pin the two
// properties the site depends on.

test('snapshot carries the support-bar total from the injected getter', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null, getBarTotal: () => 42.5 });
  assert.equal(t.snapshot().barTotal, 42.5);
});

test('barTotal is always a number, never undefined or NaN', () => {
  // Both the overlay and the site do arithmetic on this. A timer built without
  // the getter (every pre-existing caller, and every other test in this file)
  // must still put a real 0 on the wire.
  const bare = createTimer({ broadcast: () => {}, obs: null, pool: null });
  assert.equal(bare.snapshot().barTotal, 0);

  for (const bad of [() => undefined, () => null, () => 'abc', () => NaN]) {
    const t = createTimer({ broadcast: () => {}, obs: null, pool: null, getBarTotal: bad });
    const v = t.snapshot().barTotal;
    assert.equal(typeof v, 'number');
    assert.ok(Number.isFinite(v), `getter returning ${bad()} put ${v} on the wire`);
  }
});

// ── Fund the Night: night state, the de-clamped gap, persistence ─────────────
//
// During a night `remainingSec` is a GAP — funded frontier minus now — that may
// go negative, because streaming past the frontier is unpaid time the fuse
// shows. One anchor (`updatedAt`) carries two accumulators that move in
// lockstep, so their sum — the frontier — only moves when money moves it.
//
// Both halves need pinning, and the second breaks quietly: with no night
// active every number must behave as a plain countdown, because the OBS
// overlay, the site's timer libs and the support-bar math never floor a
// negative `remainingSec`.

/** A fresh `stream.timer_state` row — the column defaults. */
const FRESH_ROW = {
  running: false, remaining_sec: 10800, cap_enabled: true, cap_sec: 28800,
  usd_per_hour: 40, fill_usd: 200, base_sec: 10800,
  lock_at_zero: false, low_pulse_enabled: true, low_threshold_sec: 300,
  low_ramp_rate: 1.6, low_glow_max: 0.55,
  night_active: false, night_duration_sec: 0, night_elapsed_sec: 0,
  night_seed_sec: 7200, night_price_cents: 0, night_blocks: null,
  night_overflow_cents: 0, night_started_at: null,
};

/**
 * A `stream.timer_state` double: SELECT hands back the single row, UPDATE
 * writes the persisted columns straight back into it — so persist→reload
 * really does round-trip through the values production would store.
 *
 * The column→param mapping is read out of the UPDATE's own SET clause, not
 * hardcoded by position. A stub carrying its own copy of the column order is a
 * second source of truth, and it goes quietly wrong the day persist() gains a
 * column: the round-trip test would then be asserting against the stub's
 * imagination rather than against the statement the database will run.
 */
function fakePool(overrides = {}, { failSelects = 0, onSelect = null } = {}) {
  const row = { ...FRESH_ROW, ...overrides };
  const counts = { selects: 0, updates: 0 };
  return {
    row: () => row,
    counts,
    query: async (sql, params) => {
      const text = String(sql);
      if (/UPDATE stream\.timer_state/.test(text)) {
        counts.updates += 1;
        for (const [, col, idx] of text.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) {
          row[col] = params[Number(idx) - 1];
        }
        return { rows: [] };
      }
      counts.selects += 1;
      if (onSelect) onSelect(counts.selects);
      if (counts.selects <= failSelects) throw new Error('ECONNREFUSED 10.0.0.9:5432');
      return { rows: [row] };
    },
  };
}

/** Run `fn` with console captured — init() is chatty, and test output is a signal. */
async function quiet(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { Object.assign(console, orig); }
  return lines;
}

/** A timer mid-night, its state set directly rather than through startNight. */
function nightTimer({ gapSec = 600, elapsedSec = 3600, durationSec = 25200,
                      seedSec = 7200, running = true, pool = null } = {}) {
  const t = createTimer({ broadcast: () => {}, obs: null, pool });
  Object.assign(t.__test.st, { running, remainingSec: gapSec, updatedAt: Date.now() });
  Object.assign(t.__test.st.night, { active: true, durationSec, elapsedSec, seedSec });
  return t;
}

test('a night lets remainingSec go NEGATIVE past the frontier', () => {
  // The whole point of the de-clamp. Two minutes past a one-minute gap is a
  // two-minute deficit, not a zero — and the frontier does not move while it
  // accrues: the ember walks into unpaid territory, the rope does not retreat.
  const t = nightTimer({ gapSec: 60, elapsedSec: 3600 });
  t.__test.st.updatedAt -= 180_000; // three streamed minutes since the anchor

  const s = t.snapshot();
  assert.equal(s.remainingSec, -120, 'the wire must carry the deficit, not a floor');
  assert.equal(s.night.gapSec, -120);
  assert.equal(s.night.deficitSec, 120, 'deficit is the magnitude of a negative gap');
  assert.equal(s.night.elapsedSec, 3780, 'the elapsed clock kept walking');
  assert.equal(s.night.frontierSec, 3660, 'elapsed + gap: the frontier stood still');
  assert.equal(t.__test.frontierSec(), 3660);
  assert.equal(s.night.funded, false, 'well short of a 7h night');
});

test('the legacy path still floors remainingSec at zero — on the wire AND in the row', async () => {
  const pool = fakePool();
  const t = createTimer({ broadcast: () => {}, obs: null, pool });
  await quiet(() => t.init());

  t.set('30s');
  t.control('play');
  t.__test.st.updatedAt -= 120_000; // the marathon ran two minutes past zero

  const s = t.snapshot();
  assert.equal(s.remainingSec, 0, 'a marathon clock must never report a deficit');
  assert.equal(s.night.active, false);
  assert.equal(s.night.deficitSec, 0);
  assert.equal(s.night.funded, false, 'a night that does not exist is not "fully funded"');

  t.__test.heartbeatTick();
  assert.equal(pool.row().remaining_sec, 0, 'and it must never persist one either');
});

test('re-anchoring moves the gap DOWN and the elapsed clock UP by the same dt', () => {
  const t = nightTimer({ gapSec: 600, elapsedSec: 1800 });
  t.__test.st.updatedAt -= 90_000;
  t.control('pause'); // the mutation path that banks both accumulators

  assert.equal(Math.round(t.__test.st.remainingSec), 510, 'gap fell by 90s');
  assert.equal(Math.round(t.__test.st.night.elapsedSec), 1890, 'elapsed rose by 90s');
  assert.equal(Math.round(t.__test.frontierSec()), 2400,
    're-anchoring moved the frontier — only money may move it');
});

test('pausing freezes the gap AND the elapsed clock', () => {
  // A pause or an outage freezes everything, and the real end drifts
  // later by exactly the paused time. A paused night that kept burning elapsed
  // would sell time it never streamed.
  const t = nightTimer({ gapSec: 600, elapsedSec: 1800 });
  t.control('pause');
  const before = t.snapshot();

  t.__test.st.updatedAt -= 3_600_000; // an hour of wall clock, none of it streamed
  const after = t.snapshot();

  assert.equal(after.remainingSec, before.remainingSec);
  assert.equal(after.night.elapsedSec, before.night.elapsedSec);
  assert.equal(after.night.frontierSec, before.night.frontierSec);
});

test('during a night the ceiling is the UNSOLD territory, not the marathon cap', () => {
  // The frontier may reach the end of the night and no further: an encore is
  // `durationSec` growing, never a gap that overhangs it. The 8h marathon cap
  // is not the bound here — 25200 − 3600 = 21600 is.
  const t = nightTimer({ gapSec: 600, elapsedSec: 3600, durationSec: 25200 });
  t.set('10h');

  const s = t.snapshot();
  assert.equal(s.remainingSec, 21600, 'clamped to the night, not to cap_sec');
  assert.equal(s.night.frontierSec, 25200);
  assert.equal(s.night.funded, true, 'frontier at the ceiling = NIGHT FUNDED');
});

// A FRAME MUST NOT CONTRADICT ITSELF. `frontierSec` ships rounded while `funded` used
// to compare the raw float, and `frontierSec()` is two Date.now() deltas added together —
// so a frontier arithmetically exactly at the end of the night landed a hair under it
// about once in 3,000 frames. That frame shipped `frontierSec: 25200` (the night bought
// in full) next to `funded: false`, and the fuse overlay reads `funded` — so the gold
// state would have been withheld at the moment the community earned it.
//
// The test above cannot catch this: it is the SAME scenario and it passes ~2,999 times
// in 3,000, which is how it reached production and then failed CI once, on an unrelated
// commit, looking like a flake. So this test does NOT run the scenario and hope for the
// bad draw — a loop of 400 live attempts still missed it on 3 runs out of 3.
//
// The clock is FROZEN (`running: false`) and the gap is set a billionth of a second under
// the unsold territory. That is the dust, made deterministic: the sum is 25199.999999999,
// which rounds onto the ceiling and compares under it. The bug is then a certainty rather
// than a probability, and reverting the fix reds this test every single run.
test('a frame that says the night is bought in full must also say FUNDED', () => {
  const t = nightTimer({ gapSec: 21600 - 1e-9, elapsedSec: 3600, durationSec: 25200, running: false });
  const s = t.snapshot();

  assert.equal(s.night.frontierSec, 25200, 'the dust rounds ONTO the ceiling — that is the trap');
  assert.ok(3600 + (21600 - 1e-9) < 25200, 'and the raw sum is genuinely under it');
  assert.equal(s.night.funded, true, 'so the verdict must follow the number the frame ships');
  assert.equal(s.night.frontierSec >= s.night.durationSec, s.night.funded,
    'one frame, one story: these two can never disagree');
});

test('restart mid-COLD: the deficit, the elapsed clock and the blocks survive TWICE', async () => {
  // The cycle runs TWICE on purpose (lifecycle rule): a restart bug that
  // only bites on the SECOND cold start — state that survives one round-trip
  // and is mangled on the next — is invisible to a single-restart test.
  const blocks = [
    { startSec: 7200, lenSec: 3600, cents: 2000 },
    { startSec: 10800, lenSec: 3600, cents: 2600 },
  ];
  const pool = fakePool({
    running: true, remaining_sec: -300,
    night_active: true, night_duration_sec: 25200, night_elapsed_sec: 7200,
    night_seed_sec: 7200, night_price_cents: 22600, night_overflow_cents: 150,
    night_blocks: blocks, night_started_at: new Date('2026-08-24T02:00:00Z'),
  });

  let gap = -300;
  let elapsed = 7200;
  for (const pass of [1, 2]) {
    const t = createTimer({ broadcast: () => {}, obs: null, pool });
    await quiet(() => t.init());

    const s = t.snapshot();
    assert.equal(s.remainingSec, gap, `pass ${pass}: the deficit came back forgiven`);
    assert.equal(s.night.elapsedSec, elapsed, `pass ${pass}: the elapsed clock reset`);
    assert.equal(s.night.deficitSec, -gap);
    assert.equal(s.night.durationSec, 25200);
    assert.deepEqual(t.__test.st.night.blocks, blocks, `pass ${pass}: the priced rope was lost`);
    assert.equal(t.__test.st.night.priceCents, 22600);
    assert.equal(t.__test.st.night.overflowCents, 150);
    assert.equal(t.__test.st.night.startedAt.toISOString(), '2026-08-24T02:00:00.000Z');

    t.__test.st.updatedAt -= 60_000; // another unpaid minute of stream
    t.__test.heartbeatTick();
    gap -= 60;
    elapsed += 60;
    assert.equal(pool.row().remaining_sec, gap, `pass ${pass}: the row floored the deficit`);
    assert.equal(pool.row().night_elapsed_sec, elapsed);
    assert.equal(pool.row().night_active, true);
    assert.equal(typeof pool.row().night_blocks, 'string',
      `pass ${pass}: blocks must go to jsonb as JSON — node-pg turns a bare ARRAY ` +
      'into a Postgres array literal, which jsonb rejects');
  }
});

test('init clamps a stored negative gap only on the LEGACY path', async () => {
  const cold = fakePool({ night_active: true, night_duration_sec: 25200, remaining_sec: -900 });
  const t1 = createTimer({ broadcast: () => {}, obs: null, pool: cold });
  await quiet(() => t1.init());
  assert.equal(t1.snapshot().remainingSec, -900, 'the load clamp forgave the deficit');

  const legacy = fakePool({ remaining_sec: -900 });
  const t2 = createTimer({ broadcast: () => {}, obs: null, pool: legacy });
  await quiet(() => t2.init());
  assert.equal(t2.snapshot().remainingSec, 0, 'no night: the v59 load floor stands');
});

test('a pre-v111 row loads the coded night defaults, never NaN', async () => {
  // Against an un-migrated database these
  // columns are undefined, Number(undefined) is NaN, and the NaN rides the
  // timerState frame out to every viewer.
  const old = { ...FRESH_ROW };
  for (const k of Object.keys(old)) if (k.startsWith('night_')) delete old[k];
  const pool = fakePool();
  pool.query = async (sql) => (/UPDATE/.test(String(sql)) ? { rows: [] } : { rows: [old] });

  const t = createTimer({ broadcast: () => {}, obs: null, pool });
  await quiet(() => t.init());

  const s = t.snapshot();
  assert.equal(s.night.active, false);
  assert.equal(s.night.seedSec, 7200, 'the coded seed default');
  assert.equal(s.night.durationSec, 0);
  assert.equal(t.__test.st.night.blocks, null);
  assert.equal(t.__test.st.night.startedAt, null);
  for (const [k, v] of Object.entries(s.night)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `night.${k} went out as ${v}`);
  }
});

test('a failed load RETRIES — it never carries on with a fresh night', async () => {
  // A `catch → use the defaults` path cannot tell an empty database from an
  // unreachable one, so a DB blip at startup would open a fresh marathon over
  // a half-funded night: rope, deficit and overflow fund all gone, and the
  // first persist would make that permanent.
  //
  // The persist gate is half the fix and the quiet half. The heartbeat runs
  // on its own clock, so without it the FIRST tick after the database came back
  // would write the defaults over the night a few seconds before the retrying
  // read got there — a retry that loses the race it exists to win.
  let updatesDuringRetry = null;
  let t;
  const pool = fakePool(
    { running: true, remaining_sec: -120, night_active: true, night_duration_sec: 25200,
      night_elapsed_sec: 9000 },
    {
      failSelects: 2,
      onSelect: (n) => {
        if (n !== 2) return;
        t.__test.heartbeatTick(); // a heartbeat lands mid-retry
        updatesDuringRetry = pool.counts.updates;
      },
    },
  );
  t = createTimer({ broadcast: () => {}, obs: null, pool });

  const lines = await quiet(() => t.init({ retryMs: 1 }));

  assert.equal(pool.counts.selects, 3, 'it must keep retrying, not give up after one');
  assert.equal(updatesDuringRetry, 0, 'the heartbeat persisted defaults over a live night');
  assert.equal(t.snapshot().remainingSec, -120, 'the night came back');
  assert.equal(t.snapshot().night.elapsedSec, 9000);
  assert.equal(lines.filter((l) => /load failed/.test(l)).length, 2,
    'each failed read must say so — a silent retry loop is an invisible outage');
  assert.ok(lines.some((l) => /^\[timer] loaded .*night=/.test(l)),
    'the startup line must state the night it came up holding');
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

test('reset mid-night banks the ember and cannot overhang the end of the night', () => {
  // `reset()` was the last writer of the anchor that did not go through
  // reanchor(). During a night that lost every streamed second since the last
  // anchor, and — because it also skipped clampRemaining — it could plant the
  // frontier past `durationSec`, which is territory nobody bought and which
  // night-math refuses to price.
  const t = nightTimer({ gapSec: 600, elapsedSec: 3600, durationSec: 25200 });
  t.setConfig({ baseSec: 86400 }); // a base far past the end of the night
  t.__test.st.updatedAt -= 90_000;

  t.reset();

  const s = t.snapshot();
  assert.equal(s.night.elapsedSec, 3690, 'reset dropped 90 streamed seconds from the ember');
  assert.equal(s.remainingSec, 21510, 'the gap must be clamped to the unsold territory');
  assert.equal(s.night.frontierSec, 25200, 'the frontier may reach the end and no further');
  assert.equal(s.running, false, 'reset still pauses');
});

test('reset on the LEGACY path still ignores the cap, exactly as before', () => {
  // Deliberate, and older than the night: `!reset` to a base above the cap is a
  // mod's explicit override, so this one mutation does not clamp. The night
  // branch above must not have leaked into it.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ baseSec: 36000 }); // 10h, against the 8h default cap
  t.reset();
  assert.equal(t.snapshot().remainingSec, 36000, 'reset must not clamp a marathon to cap_sec');
});

test('ending a night must not erase the night that just ran', async () => {
  // `liveElapsed()` returned 0 whenever `night.active` was false, and both
  // reanchor() and persist() write that return value — so the next mutation or
  // heartbeat after a night ended would zero the ember in memory AND in the
  // row. The night's own record of how long it ran is not something a
  // deactivation may destroy; frozen, not zeroed.
  const pool = fakePool();
  const t = createTimer({ broadcast: () => {}, obs: null, pool });
  await quiet(() => t.init());
  Object.assign(t.__test.st, { running: true, remainingSec: 600, updatedAt: Date.now() });
  Object.assign(t.__test.st.night, { active: true, durationSec: 25200, elapsedSec: 7200 });

  t.__test.st.night.active = false;         // whatever ends a night
  t.__test.st.updatedAt -= 120_000;         // and the clock keeps running after it
  assert.equal(t.snapshot().night.elapsedSec, 7200, 'a dead night must FREEZE, not tick');

  t.adjust('5m');                           // any mutation re-anchors
  assert.equal(Math.round(t.__test.st.night.elapsedSec), 7200, 'reanchor zeroed the ember');
  assert.equal(pool.row().night_elapsed_sec, 7200, 'the persisted row zeroed the ember');
});

test('pausing and resuming a COLD night freezes the deficit', () => {
  // A pause during a cold walk is ordinary (a BRB, a crash). Neither
  // accumulator may move, and resuming must not retroactively charge for the
  // time off air: the real end drifts later by exactly the paused time.
  const t = nightTimer({ gapSec: -300, elapsedSec: 9000 });
  t.__test.st.updatedAt -= 60_000; // another unpaid minute before the pause

  t.control('pause');
  const paused = t.snapshot();
  assert.equal(paused.remainingSec, -360);
  assert.equal(paused.night.deficitSec, 360);
  assert.equal(paused.night.elapsedSec, 9060);

  t.__test.st.updatedAt -= 3_600_000; // an hour off air
  assert.equal(t.snapshot().remainingSec, -360, 'the deficit deepened while paused');
  assert.equal(t.snapshot().night.elapsedSec, 9060, 'the ember walked while paused');

  t.control('play');
  const resumed = t.snapshot();
  assert.equal(resumed.remainingSec, -360, 'resuming charged for the pause');
  assert.equal(resumed.night.elapsedSec, 9060);
  assert.equal(resumed.night.frontierSec, 8700, 'the frontier survived the pause');
});

// ── Fund the Night: the lifecycle + curve conversion ─────────────────────────
//
// Starting a night, pricing it, spending money into it and ending it. The properties that matter are economic, so
// every assertion below is an exact number derived from the night's own blocks —
// "more than before" would pass over a curve that had quietly gone flat.

/**
 * A started night: an 8h clock, the 2h seed, and a hand-checkable $362 price —
 * the same shape `night-math.test.js` lays out, so the six blocks and their
 * exact cents are already pinned one layer down.
 *
 * `running` is left FALSE on purpose. A paused clock makes `liveGap` and
 * `liveElapsed` pure reads of the stored numbers, so every conversion assertion
 * is exact rather than "within a tick". The tests that need real streamed time
 * play the clock themselves and rewind the anchor.
 */
function startedNight({ priceCents = 36200, seedSec = 7200, endLocal = '+8h' } = {}) {
  const sent = [];
  const t = createTimer({ broadcast: (m) => sent.push(m), obs: null, pool: null });
  t.startNight({ endLocal, seedSec, priceCents });
  return { t, sent, blocks: t.__test.st.night.blocks };
}

test('startNight converts a local END TIME into a streamed DURATION', () => {
  // The streamer sets a bedtime in their own timezone and it is converted,
  // once, at stream start. Everything after that lives in streamed seconds. Tested
  // through an injected `now` because a test that asks the real clock what
  // "the next 4am" is asserts a different number every day it runs.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const tz = 'America/Chicago';
  const evening = Date.parse('2026-08-24T02:00:00Z'); // 21:00 CDT on the 23rd
  const morning = Date.parse('2026-08-24T10:00:00Z'); // 05:00 CDT on the 24th

  t.startNight({ endLocal: '4am', tz, now: evening });
  assert.equal(t.__test.st.night.durationSec, 25200, 'seven hours to the next 4am');

  // 4am is BEHIND us: the night runs to TOMORROW's 4am, not to a negative one.
  t.startNight({ endLocal: '4am', tz, now: morning });
  assert.equal(t.__test.st.night.durationSec, 82800);

  for (const [form, secs] of [
    ['4:30am', 27000], ['04:30', 27000], ['11pm', 7200], ['23:00', 7200],
    ['4AM', 25200], [' 4 am ', 25200], ['12am', 10800], ['12pm', 54000],
  ]) {
    t.startNight({ endLocal: form, tz, now: evening, seedSec: 0 });
    assert.equal(t.__test.st.night.durationSec, secs, `"${form}" parsed to the wrong end`);
  }
});

test('an explicit seedSec on one night must NOT become the default for the next (it would leak seed=0 into later nights)', () => {
  // A night started with an explicit `seedSec: 0` must not make every later
  // night open with no free hours: the fallback for an omitted seed is a
  // constant, not the persisted per-night value. The default is a property of
  // the design, not of the previous night.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const tz = 'America/Chicago';
  const evening = Date.parse('2026-08-24T02:00:00Z');
  t.startNight({ endLocal: '4am', tz, now: evening, seedSec: 0 });
  assert.equal(t.__test.st.night.seedSec, 0, 'premise: the explicit zero seed is honored for THIS night');
  t.endNight();
  t.startNight({ endLocal: '4am', tz, now: evening });
  assert.equal(t.__test.st.night.seedSec, 7200, 'an omitted seed is the two-hour default, not last night\'s override');
  assert.equal(t.__test.st.remainingSec, 7200, 'and the gap opens at that seed');
});

test('startNight at exactly local MIDNIGHT measures from the right day', () => {
  // The hour that breaks timezone code. Some ICU builds render midnight as hour
  // 24 rather than 0, and 24 carried on the NEW day's date is a full day off —
  // an eight-hour night sold as a thirty-two-hour one. (This build reports 0, so
  // the guard in `tzFields` is not exercised here; the assertion is what would
  // catch a build or a refactor that lost it.)
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.startNight({ endLocal: '4am', tz: 'America/Chicago', now: Date.parse('2026-08-24T05:00:00Z') });
  assert.equal(t.__test.st.night.durationSec, 14400, 'midnight to 4am is four hours');
});

test('startNight counts REAL seconds across a DST fall-back, not wall-clock hours', () => {
  // 2026-11-01 is the US fall-back. 23:30 CDT on the 31st to 4am CST is four
  // and a half hours on the wall and five and a half real ones — and the night
  // is sold in real streamed seconds, so it must be the latter. Naive
  // "same offset all night" arithmetic sells an hour that does not exist.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.startNight({ endLocal: '4am', tz: 'America/Chicago', now: Date.parse('2026-11-01T04:30:00Z') });
  assert.equal(t.__test.st.night.durationSec, 19800);
});

test("startNight accepts a relative '+Nh' end", () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.startNight({ endLocal: '+8h' });
  assert.equal(t.__test.st.night.durationSec, 28800);
  t.startNight({ endLocal: '+2.5h' });
  assert.equal(t.__test.st.night.durationSec, 9000);
});

test('an unparseable end time throws a NAMED error rather than opening a bogus night', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const named = (e) => e.name === 'NightConfigError' && e.code === 'INVALID_END_LOCAL';
  for (const bad of ['later', '25:00', '13pm', '4:75', '', null, undefined, '+0h', '-2h']) {
    assert.throws(() => t.startNight({ endLocal: bad }), named, `"${bad}" was accepted`);
  }
  // A bare hour is refused for the same reason a bare cap is (the 08-13
  // 10-second cap): "4" is 4am or 4pm, a twelve-hour error in the night's
  // length, and every block's price is derived from that length.
  for (const ambiguous of ['4', '16', ' 4 ']) {
    assert.throws(() => t.startNight({ endLocal: ambiguous }), /ambiguous/,
      `"${ambiguous}" was guessed at instead of refused`);
  }
  assert.equal(t.__test.st.night.active, false, 'a rejected end must leave no half-open night');
});

test('startNight seeds the gap, zeroes the ember, clears the overflow and retires lockAtZero', () => {
  const sent = [];
  const t = createTimer({ broadcast: (m) => sent.push(m), obs: null, pool: null });
  // What last night left behind: a banked ember, a live overflow fund, and the
  // legacy floor lock still set in the row.
  t.setConfig({ lockAtZero: true });
  Object.assign(t.__test.st.night, { elapsedSec: 9999, overflowCents: 4200 });

  t.startNight({ endLocal: '+8h', seedSec: 7200, priceCents: 36200 });

  const n = t.__test.st.night;
  assert.equal(n.active, true);
  assert.equal(n.durationSec, 28800);
  assert.equal(n.elapsedSec, 0, 'the ember must restart — the deficit dies with the night');
  assert.equal(n.overflowCents, 0, "last night's overflow may not fund this one");
  assert.equal(n.seedSec, 7200);
  assert.equal(n.priceCents, 36200);
  assert.equal(n.blocks.length, 6, 'six sellable hours after a two-hour seed');
  assert.equal(n.blocks[0].startSec, 7200, 'the first sellable second is the end of the seed');
  assert.equal(n.blocks.reduce((s, b) => s + b.cents, 0), 36200, 'the blocks must sum to the price');
  assert.ok(n.startedAt instanceof Date);
  assert.equal(t.config().lockAtZero, false,
    'lockAtZero is RETIRED for nights — left on, it refuses the revival donation');

  const s = t.snapshot();
  assert.equal(s.remainingSec, 7200, 'the gap opens at the seed');
  assert.equal(s.night.frontierSec, 7200, 'the frontier starts at the first sellable second');
  assert.equal(s.night.funded, false);
  assert.equal(sent.at(-1).type, 'timerState', 'starting a night must broadcast one');
});

test('startNight without a price uses the $24/h floor against the day\'s requirement', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.startNight({ endLocal: '+8h', seedSec: 7200 });
  assert.equal(t.__test.st.night.priceCents, 19200, '$24 × 8 clock hours, seed included');

  t.startNight({ endLocal: '+8h', seedSec: 7200, requiredCentsPerDay: 36200 });
  assert.equal(t.__test.st.night.priceCents, 36200, "a struggling day's required wins");

  // An omitted seed takes the configured default; a JSON `null` from the route
  // is an omission too — read as a number it would be 0, i.e. no free hours.
  for (const omitted of [undefined, null]) {
    t.startNight({ endLocal: '+8h', seedSec: omitted, priceCents: 36200 });
    assert.equal(t.__test.st.night.seedSec, 7200, `seedSec: ${omitted} wiped the seed`);
    assert.equal(t.__test.st.night.blocks.length, 6);
  }
  // A seed longer than the night is clamped to it: nothing sellable, no crash.
  t.startNight({ endLocal: '+1h', seedSec: 7200 });
  assert.equal(t.__test.st.night.seedSec, 3600);
  assert.equal(t.__test.st.night.blocks.length, 0);
});

test('a donation worth exactly one block buys exactly that block', () => {
  const { t, sent, blocks } = startedNight();

  assert.equal(t.addMoney(blocks[0].cents / 100), 3600, 'the first hour, to the second');
  assert.equal(t.snapshot().remainingSec, 10800);
  assert.equal(t.snapshot().night.frontierSec, 10800);
  assert.equal(sent.at(-1).deltaSec, 3600, 'the overlay pops the seconds it bought');

  // The SAME money one hour later buys LESS — the curve is the whale damper,
  // and it is the only thing making a late minute worth more than an early one.
  const second = t.addMoney(blocks[0].cents / 100);
  assert.equal(second, Math.round(blocks[0].cents * 3600 / blocks[1].cents));
  assert.ok(second < 3600, 'the second hour must cost more than the first');
});

test('a COLD donation returns GROSS seconds while the gap nets through zero in public', () => {
  // Law 4: receipts are gross and lock at purchase; the clock nets in public.
  // The card says "+60 min" while the countdown rolls −0:05 → +0:55.
  const { t, sent, blocks } = startedNight();
  t.control('play');
  t.__test.st.updatedAt -= 7_500_000; // 2h05m streamed — five minutes past the seed

  assert.equal(t.snapshot().remainingSec, -300);
  assert.equal(t.snapshot().night.deficitSec, 300);
  assert.equal(t.snapshot().night.frontierSec, 7200, 'everything behind the ember is ash');

  const applied = t.addMoney(blocks[0].cents / 100);
  assert.equal(applied, 3600, 'the CARD shows the gross hour, deficit or no deficit');
  const s = t.snapshot();
  assert.equal(s.remainingSec, 3300, 'the CLOCK nets: −300 + 3600');
  assert.equal(s.night.deficitSec, 0, 'the revival paid the debt first');
  assert.equal(s.night.frontierSec, 10800, 'the frontier moved by the gross seconds');
  assert.equal(sent.at(-1).deltaSec, 3600);
});

test('gold banks the overflow, flips funded, and NEVER refuses the money', () => {
  const { t, blocks } = startedNight();

  assert.equal(t.addMoney(362), 21600, 'the whole night price buys the whole sellable stretch');
  const gold = t.snapshot();
  assert.equal(gold.night.frontierSec, 28800);
  assert.equal(gold.night.funded, true, 'frontier at the ceiling = NIGHT FUNDED');
  assert.equal(gold.remainingSec, 28800);
  assert.equal(t.__test.st.night.overflowCents, 0, 'an exactly-gold night banks nothing');

  const past = t.addMoney(10); // $10 with no territory left to sell
  assert.equal(past, 0, 'there is no time left to sell tonight');
  assert.equal(t.__test.st.night.overflowCents, 1000,
    'law 2: money is never refused — only time. It banks for the encore');
  assert.equal(t.snapshot().night.funded, true);
  assert.equal(blocks.length, 6, 'banking overflow must not lay new blocks by itself');
});

test('the ceiling lock during a night is the END OF THE NIGHT, not the marathon cap', () => {
  // Deliberately a FOUR-hour night. An eight-hour one goes gold at exactly
  // cap_sec (28800), where the legacy `liveGap() >= capSec` test gives the same
  // answer for the wrong reason — an assertion that cannot tell the two apart
  // is not an assertion. At four hours the cap can never fire, so `locked` here
  // is true only if `atCeiling` really reads the night.
  const { t } = startedNight({ endLocal: '+4h', priceCents: 12000 });
  assert.equal(t.config().capEnabled, true, 'the 8h marathon cap is still configured');
  assert.equal(t.snapshot().locked, false, 'a night at its seed is not locked');

  t.addMoney(120); // the whole price of a four-hour night
  const gold = t.snapshot();
  assert.equal(gold.night.frontierSec, 14400);
  assert.equal(gold.night.funded, true);
  assert.ok(gold.remainingSec < 28800, 'the marathon cap is nowhere near — this is the night');
});

test('a GOLD night is NOT `locked` on the wire — the padlock is a marathon word', () => {
  // `locked` reaches the site's timer pill as a
  // padlock and a "Marathon timer — locked" tooltip. At gold that is a lie in
  // the one direction that costs money: the night is FULLY FUNDED and every
  // cent is still accepted (money is never refused, only time), while
  // the pill tells a viewer the timer is shut. `night.funded` is the gold
  // signal; `locked` stays the legacy marathon's word for a legacy marathon's
  // state.
  const { t } = startedNight({ endLocal: '+4h', priceCents: 12000 });
  t.addMoney(120); // gold

  const gold = t.snapshot();
  assert.equal(gold.night.funded, true, 'premise: this frame is gold, or the assertion below proves nothing');
  assert.equal(gold.locked, false, 'a funded night must not carry the marathon padlock');
  assert.ok(t.addMoney(20) === 0 && t.__test.st.night.overflowCents > 0,
    'premise: money is still fully accepted at gold — it banks for the encore');

  // …and the legacy cap lock is untouched: this is a night-only exemption.
  const legacy = createTimer({ broadcast: () => {}, obs: null, pool: null });
  legacy.setConfig({ cap: '8h' });
  legacy.set('8h');
  assert.equal(legacy.snapshot().night.active, false, 'premise: no night here');
  assert.equal(legacy.snapshot().locked, true, 'a capped marathon at its ceiling is still locked');
});

test('extendNight widens the night FIRST, then drains the overflow into the encore', () => {
  const { t, sent, blocks } = startedNight();
  t.addMoney(362); // gold
  t.addMoney(10);  // $10 into the overflow fund
  const before = t.snapshot().remainingSec;

  t.extendNight(1);

  const n = t.__test.st.night;
  // The order is not cosmetic: night-math THROWS if the blocks outrun
  // durationSec, so a drain against a stale duration would blow up here rather
  // than silently hand the money back — which is what this whole test would
  // fail on if the widening moved after the drain.
  assert.equal(n.durationSec, 32400, 'the duration must widen with the blocks');
  assert.equal(n.blocks.length, 7);
  assert.equal(n.blocks[6].cents, Math.round(blocks[5].cents / blocks[5].lenSec * 3600),
    'the encore prices FLAT at the final block\'s rate');

  const expected = Math.round(1000 * 3600 / n.blocks[6].cents);
  assert.equal(t.snapshot().remainingSec, before + expected, 'the frontier surged by the drained seconds');
  assert.equal(n.overflowCents, 0, 'the fund emptied into the encore');
  assert.equal(sent.at(-1).deltaSec, expected, 'the overlay must see the encore surge');
  assert.equal(t.snapshot().night.funded, false, 'there is territory to sell again');
});

test('an overflow bigger than the encore drains oldest-first and banks the remainder', () => {
  // One bank, so "oldest first" IS the arithmetic: the encore hour is bought
  // whole at its own price and only what is left over stays banked.
  const { t, blocks } = startedNight();
  t.addMoney(362);                          // gold
  t.addMoney((blocks[5].cents * 2) / 100);  // two final-hours' worth of overflow
  assert.equal(t.__test.st.night.overflowCents, blocks[5].cents * 2);

  t.extendNight(1); // only ONE hour of encore to buy

  const n = t.__test.st.night;
  assert.equal(t.snapshot().night.frontierSec, 32400, 'the drain filled the whole encore hour');
  assert.equal(n.overflowCents, blocks[5].cents * 2 - n.blocks[6].cents,
    'the rest stays banked for the next extension');
  assert.equal(t.snapshot().night.funded, true, 'gold again, one hour later');
});

test('extendNight refuses a night with nothing priced, and is inert with no night', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  assert.equal(t.extendNight(1).night.active, false, 'a marathon has no night to extend');

  t.startNight({ endLocal: '+1h', seedSec: 7200 }); // the seed covers the whole clock
  assert.equal(t.__test.st.night.blocks.length, 0, 'nothing sellable, nothing priced');
  assert.throws(() => t.extendNight(1), (e) => e.name === 'NightConfigError');
  assert.equal(t.__test.st.night.durationSec, 3600, 'and it must not half-widen the night');
});

test('repriceNight re-lays the SAME curve at the new total; the frontier is conserved', () => {
  // When the meter's required-$/day is wrong, the target is settable
  // mid-night. The contract is exact: the new blocks are what
  // startNight would have laid for the new price — same U shape, new total —
  // and nothing about TIME moves (funded stays funded; receipts lock at
  // purchase, so nothing already granted is re-valued either way).
  const { layoutBlocks } = require('./night-math');
  const { t, sent } = startedNight(); // 8h, 2h seed, $362 — six pinned blocks
  t.addMoney(50); // some territory funded at the OLD rates stays exactly bought
  const before = t.snapshot();
  const sentBefore = sent.length;

  const snap = t.repriceNight(18100); // half the night price
  assert.equal(t.__test.st.night.priceCents, 18100);
  assert.deepEqual(t.__test.st.night.blocks, layoutBlocks(28800, 7200, 18100),
    'the reprice is startNight\'s own layout at the new price, nothing bespoke');
  assert.equal(t.__test.st.night.blocks.reduce((s, b) => s + b.cents, 0), 18100,
    'the blocks still sum to exactly the (new) whole price');
  assert.equal(snap.remainingSec, before.remainingSec, 'no time moved');
  assert.equal(snap.night.frontierSec, before.night.frontierSec, 'funded stays funded');
  assert.equal(snap.night.elapsedSec, before.night.elapsedSec);
  assert.equal(sent.length, sentBefore + 1, 'the frame re-states the night');
  assert.equal(sent.at(-1).deltaSec, 0, 'with no +/- popup — nothing was bought');

  // Money arriving AFTER the reprice buys at the NEW rates. Exact on a fresh
  // night (no partial-block position to prorate): paying the first two NEW
  // blocks' integer cents lands the frontier exactly at block 2's start.
  const { t: tf } = startedNight();
  tf.repriceNight(18100);
  const nb = tf.__test.st.night.blocks;
  tf.addMoney((nb[0].cents + nb[1].cents) / 100);
  assert.equal(Math.round(tf.__test.conversionFrontier()), nb[2].startSec,
    'post-reprice cents walked the NEW curve');
});

test('repriceNight refuses without a night or a readable price, and a refusal changes nothing', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  assert.throws(() => t.repriceNight(18100),
    (e) => e.name === 'NightConfigError' && e.code === 'NO_NIGHT',
    'a marathon has no night to re-price');

  const { t: t2 } = startedNight();
  const before = JSON.stringify(t2.__test.st.night);
  for (const bad of [0, -5, NaN, 'x', undefined]) {
    assert.throws(() => t2.repriceNight(bad),
      (e) => e.name === 'NightConfigError' && e.code === 'BAD_TARGET', `accepted ${bad}`);
  }
  assert.equal(JSON.stringify(t2.__test.st.night), before,
    'a refused reprice must not half-apply');

  // A GOLD night reprices inertly: the frontier is at the end, nothing is left
  // to buy, and the banked overflow is not touched — it still waits for an
  // encore, which will price from the NEW final block.
  const { t: t3 } = startedNight();
  t3.addMoney(400); // $38 past gold
  assert.equal(t3.snapshot().night.funded, true, 'premise: gold');
  t3.repriceNight(18100);
  assert.equal(t3.__test.st.night.overflowCents, 3800, 'the encore fund is not re-valued');
  assert.equal(t3.snapshot().night.funded, true, 'and gold stays gold');
});

test('convertNotional is the SAME conversion as a pure query (law 7)', () => {
  const { t, sent, blocks } = startedNight();
  const before = t.snapshot();
  const sentBefore = sent.length;

  assert.equal(t.convertNotional(blocks[0].cents / 100), 3600,
    'the badge/rotation quantity is the same curve the clock got');
  assert.deepEqual(t.snapshot(), before, 'a quote must not move the clock');
  assert.equal(sent.length, sentBefore, 'a quote must not broadcast');

  // Past gold there is nothing left to sell, so the quote falls to the FINAL
  // block's rate — exactly what an encore would grant for the same money.
  t.addMoney(362);
  assert.equal(t.convertNotional(10), Math.round(1000 * blocks[5].lenSec / blocks[5].cents));

  // A donation that straddles the ceiling: sold seconds at their block price
  // plus the overflow at the final rate, in ONE number.
  const { t: t2, blocks: b2 } = startedNight();
  t2.addMoney(362 - b2[5].cents / 100); // one final-hour short of gold
  const straddle = t2.convertNotional((b2[5].cents + 1000) / 100);
  assert.equal(straddle, 3600 + Math.round(1000 * b2[5].lenSec / b2[5].cents));
});

test('convertNotional with no night is the legacy flat conversion', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  assert.equal(t.convertNotional(40), 3600, '$40 at the default $40/hr');
  assert.equal(t.convertNotional(10), 900);
  assert.equal(t.convertNotional(0), 0);
  assert.equal(t.convertNotional('nonsense'), 0);
});

test('a mod cannot un-sell the seed: the night clamp floors the frontier at seedSec', () => {
  // This clamp is what keeps `/timer sub` from arming night-math's throw: a
  // conversion that starts below the first sellable block would price the free
  // seed region, so night-math refuses it — and the refusal would land inside
  // the money path.
  const { t, blocks } = startedNight();
  t.addMoney(blocks[0].cents / 100);
  assert.equal(t.snapshot().night.frontierSec, 10800);

  const applied = t.adjust('10h', -1); // a mod takes ten hours off a three-hour rope
  assert.equal(t.snapshot().remainingSec, 7200, 'the gap floors at seedSec − elapsed');
  assert.equal(t.snapshot().night.frontierSec, 7200, 'the frontier may never fall below the seed');
  assert.equal(applied, -3600, 'only the sold hour came off');

  t.set('1m'); // and an absolute set cannot go under it either
  assert.equal(t.snapshot().night.frontierSec, 7200);

  // The clamp is only worth having if the next donation still converts.
  assert.equal(t.addMoney(blocks[0].cents / 100), 3600, 'the next donation threw or bought nothing');
});

test('a frontier a FLOAT-HAIR under the seed still converts — it must not throw', () => {
  // The clamp parks the frontier exactly ON seedSec, and night-math THROWS on a
  // frontier below the first sellable block (it would price the free seed).
  // Those two facts meet at a floating-point edge: the gap and the ember are
  // banked as two independently rounded numbers, so `(seed − dt) + dt` is not
  // always `seed`. The pair below is what two ORDINARY re-anchors 1ms and 2ms
  // apart actually produce — 7199.999999999999, nine hundred femtoseconds under
  // the seed. Unsnapped, the next donation throws INSIDE the money path, which
  // is the worst place in the system for an exception to appear.
  const { t, blocks } = startedNight();
  Object.assign(t.__test.st, { remainingSec: 7199.996999999999 });
  t.__test.st.night.elapsedSec = 0.003;
  assert.ok(t.__test.frontierSec() < 7200, 'the float edge this test exists for did not reproduce');

  assert.equal(t.__test.conversionFrontier(), 7200, 'sub-second dust must snap to the seed');
  assert.equal(t.addMoney(blocks[0].cents / 100), 3600, 'the donation threw or bought nothing');

  // …and a REAL violation is still loud: a frontier a full hour under the seed
  // is a corrupted night, not dust, and night-math must be allowed to say so.
  const { t: t2 } = startedNight();
  t2.__test.st.remainingSec = 3600;
  assert.throws(() => t2.addMoney(10), /frontierSec below first sellable block/);
});

test('lockAtZero is RETIRED during a night — the revival donation is never refused', () => {
  const { t, blocks } = startedNight();
  t.__test.st.lockAtZero = true; // e.g. a row from before nights that still carries it
  t.control('play');
  t.__test.st.updatedAt -= 7_500_000; // cold: five minutes of unpaid stream

  assert.equal(t.snapshot().remainingSec, -300);
  assert.equal(t.snapshot().locked, false, 'the floor lock is retired for nights');
  assert.ok(t.addMoney(blocks[0].cents / 100) > 0, 'the revival donation bought nothing');
  assert.ok(t.adjust('5m', 1) > 0, 'a mod could not add time either');
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

test('endNight hands the clock back INSIDE the marathon cap, never above it', () => {
  // A night can legitimately end with a gap larger than `cap_sec` — a 9h night
  // gone gold is 32400s of funded time against an 8h cap. Handed back raw, the
  // legacy clamp then bites on the NEXT donation instead: `clamp(gap + added)`
  // is the cap, so `applied = 28800 − 32400 = −3600` and a $40 tip broadcasts a
  // deltaSec of MINUS an hour — the overlay pops "−60 min" at a donor.
  //
  // The night's overage does not belong on the marathon clock: the night is
  // over. A mod who wants to carry time forward uses `/timer set`.
  const { t, sent } = startedNight({ endLocal: '+9h', priceCents: 40000 });
  t.addMoney(400); // gold: the frontier reaches 32400
  assert.equal(t.snapshot().night.frontierSec, 32400);
  assert.ok(t.snapshot().remainingSec > t.config().capSec, 'the setup must exceed the cap');

  t.endNight();

  assert.equal(t.snapshot().remainingSec, 28800, 'the handoff must land inside the cap');
  assert.equal(t.__test.st.remainingSec, 28800);

  const applied = t.addMoney(40);
  assert.equal(applied, 0, 'a donation at the ceiling adds nothing — it must never SUBTRACT');
  assert.ok(sent.at(-1).deltaSec >= 0, `the overlay was told ${sent.at(-1).deltaSec}s`);
});

test('endNight still floors a COLD handoff at zero, and leaves an ordinary one alone', () => {
  // The clamp on handoff must not have eaten either of the other two cases.
  const cold = startedNight().t;
  cold.control('play');
  cold.__test.st.updatedAt -= 7_500_000; // five unpaid minutes
  cold.endNight();
  assert.equal(cold.__test.st.remainingSec, 0, 'the deficit must still die with the night');

  const ordinary = startedNight().t;
  ordinary.addMoney(50); // some time bought, nowhere near the cap
  const before = ordinary.snapshot().remainingSec;
  ordinary.endNight();
  assert.equal(ordinary.snapshot().remainingSec, before, 'an in-cap gap must be handed back whole');
});

test('endNight() with NO night active is inert — it must not clamp a deliberately over-cap marathon', () => {
  // An unconditional clamp in `endNight` would re-clamp a legacy clock into the
  // cap when ending a night that was never started. That
  // clock is the ONE mutation the ceiling deliberately does not bound (`!reset`
  // to a base above the cap is a mod's explicit override), and a stray "end
  // night" — a double-tap on the panel, a retried request — silently ate the
  // override. Nothing to end = nothing to change.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ baseSec: 36000 }); // a 10h default against the 8h cap
  t.reset();
  assert.equal(t.snapshot().night.active, false, 'premise: there is no night to end');
  assert.equal(t.snapshot().remainingSec, 36000, 'premise: the mod override is above the cap');

  const result = t.endNight();

  assert.equal(t.__test.st.remainingSec, 36000, 'ending a night that never started clamped the marathon');
  assert.equal(result.remainingSec, 36000, 'and told the wire the shortened number');
});

test('a degenerate night quotes ZERO, because that is what its clock will grant', () => {
  // `startNight` allows a night the seed covers whole (end '+1h' against the 2h
  // seed): nothing is sellable, so `addMoney` banks every cent to overflow and
  // buys 0 seconds. Falling through to the legacy flat rate there would quote
  // 900s for the same $10 — a badge promising fifteen minutes the clock will
  // never grant. The quote and the clock must agree.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.startNight({ endLocal: '+1h', seedSec: 7200 });
  assert.equal(t.__test.st.night.blocks.length, 0, 'the repro needs a night with nothing sellable');

  assert.equal(t.convertNotional(10), 0, 'the quote promised minutes the night cannot sell');
  assert.equal(t.addMoney(10), 0, 'and this is what the clock actually grants');
  assert.equal(t.__test.st.night.overflowCents, 1000, 'the money still banks — law 2');

  // The legacy fall-through is still there for the world it belongs to.
  t.endNight();
  assert.equal(t.convertNotional(10), 900, 'no night = the flat $40/hr quote');
});

test('the dust-snap window is 50ms — wide enough for float dust, no wider', () => {
  // The snap exists for ~2e-11s of accumulator rounding. A window of a whole
  // second would also swallow a REAL sub-seed frontier (a mod subtracting one
  // second past the floor), which is a corrupted night night-math must be
  // allowed to shout about. Both sides of the boundary are pinned so a future
  // widening has to argue with a test.
  const { t, blocks } = startedNight();
  t.__test.st.remainingSec = 7200 - 0.04; // inside the window: dust
  assert.equal(t.__test.conversionFrontier(), 7200);
  assert.equal(t.addMoney(blocks[0].cents / 100), 3600, 'dust must still convert');

  const { t: t2 } = startedNight();
  t2.__test.st.remainingSec = 7200 - 0.06; // outside it: a real violation
  assert.equal(t2.__test.conversionFrontier(), 7200 - 0.06, 'this one must NOT be snapped');
  assert.throws(() => t2.addMoney(10), /frontierSec below first sellable block/);
});

test('a night STARTED through the API survives a restart and keeps converting', async () => {
  // The persistence tests above use a hand-written row. This pins it against
  // the row `startNight` actually writes — the blocks a real layout
  // produces, the price it computed, the frontier it opened — and then spends
  // money into the reloaded night, because a rope that comes back unusable has
  // not really come back.
  const pool = fakePool();
  const t = createTimer({ broadcast: () => {}, obs: null, pool });
  await quiet(() => t.init());
  t.startNight({ endLocal: '+8h', seedSec: 7200, priceCents: 36200 });
  const blocks = t.__test.st.night.blocks;
  t.addMoney(blocks[0].cents / 100); // one hour bought before the crash

  assert.equal(pool.row().night_active, true);
  assert.equal(pool.row().night_price_cents, 36200);
  assert.equal(pool.row().remaining_sec, 10800);

  const t2 = createTimer({ broadcast: () => {}, obs: null, pool });
  await quiet(() => t2.init());
  const s = t2.snapshot();
  assert.equal(s.night.durationSec, 28800);
  assert.equal(s.night.seedSec, 7200);
  assert.equal(s.night.frontierSec, 10800, 'the funded frontier came back short');
  assert.deepEqual(t2.__test.st.night.blocks, blocks, 'the priced rope did not survive jsonb');
  assert.equal(t2.addMoney(blocks[1].cents / 100), 3600,
    'the reloaded night must price the NEXT hour, not re-price the first');
});

test('endNight banks the ember, kills the deficit, and hands the clock back to legacy rules', () => {
  const { t } = startedNight();
  t.control('play');
  t.__test.st.updatedAt -= 7_500_000; // 2h05m streamed, five minutes of it unpaid

  t.endNight();

  const n = t.__test.st.night;
  assert.equal(n.active, false);
  assert.equal(Math.round(n.elapsedSec), 7500, 'the night that just ran must not be erased');
  const s = t.snapshot();
  assert.equal(s.night.elapsedSec, 7500);
  assert.equal(s.remainingSec, 0, 'the deficit dies with the night — it never crosses into tomorrow');
  // The INTERNAL, not just the frame. `wireRemaining()` floors a negative gap
  // the moment `active` is false, so the wire says 0 either way — the thing that
  // needs pinning is that the stored number agrees with it, rather than leaving
  // a dead night's debt sitting in memory for the next reader to trip over.
  assert.equal(t.__test.st.remainingSec, 0, 'the ended night left its deficit in state');
  assert.equal(s.night.deficitSec, 0);
  assert.equal(s.night.funded, false, 'an ended night is not a funded one');
  assert.equal(t.addMoney(40), 3600, 'the legacy $40/hr conversion is back');
});

// ── Fund the Night: pauseRetroactive ─────────────────────────────────────────
//
// night-liveness.js calls this on a sustained outage instead of `control
// ('pause')` — the clock must be corrected back to the last provably-live
// instant, not merely frozen where it sits after the outage (plus the
// debounce that detected it) already burned unpaid time.

test('pauseRetroactive refunds the un-streamed stretch from elapsed back to the gap, exactly', () => {
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200, seedSec: 0 });
  const now = Date.now();
  t.__test.st.updatedAt = now - 400_000; // 400 real seconds since the last anchor
  const sinceMs = now - 300_000;         // last provably live 300s ago — a 300s outage

  t.pauseRetroactive(sinceMs);

  const s = t.snapshot();
  // reanchor() first banks the full 400s (gap 5000→4600, elapsed 3600→4000);
  // THEN the retroactive refund claws back just the outage's 300s.
  assert.equal(s.running, false);
  assert.equal(Math.round(s.remainingSec), 4900, 'gap = 4600 (banked) + 300 (refund)');
  assert.equal(Math.round(s.night.elapsedSec), 3700, 'elapsed = 4000 (banked) − 300 (refund)');
});

test('pauseRetroactive on a NIGHT with no active night degrades to an ordinary pause', () => {
  // Retroactivity is a night concept. No night → no ember, no frontier to
  // conserve — `sinceMs` must be ignored entirely, not fed into any formula.
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.control('play');
  t.__test.st.updatedAt -= 50_000; // 50s of an ordinary marathon

  t.pauseRetroactive(Date.now() - 999_999); // an absurd anchor — must be ignored, not applied
  const s = t.snapshot();
  assert.equal(s.running, false);
  assert.equal(Math.round(s.remainingSec), 10800 - 50,
    'an ordinary pause banked 50s — the huge sinceMs must not have refunded anything');
});

test('pauseRetroactive on a COLD night (already-negative gap) still refunds correctly', () => {
  // The deficit predates the outage; pauseRetroactive must not erase it —
  // only the outage's OWN un-streamed stretch is clawed back, leaving the
  // rest of the deficit exactly where it was.
  const t = nightTimer({ gapSec: -1000, elapsedSec: 5000, durationSec: 25200, seedSec: 0 });
  const now = Date.now();
  t.__test.st.updatedAt = now - 300_000; // 300 real seconds since the last anchor
  const sinceMs = now - 120_000;         // last provably live 120s ago

  t.pauseRetroactive(sinceMs);

  const s = t.snapshot();
  // banked: gap −1000−300=−1300, elapsed 5000+300=5300. refund 120:
  // gap −1300+120=−1180 (still cold), elapsed 5300−120=5180.
  assert.equal(Math.round(s.remainingSec), -1180, 'still a deficit — the outage did not erase the pre-existing one');
  assert.equal(Math.round(s.night.elapsedSec), 5180);
  assert.equal(s.night.deficitSec, 1180);
});

test('pauseRetroactive clips the refund at the elapsed FLOOR, keeping the frontier invariant', () => {
  // An anchor older than the whole current elapsed run: a bare `dt` would try
  // to push elapsedSec negative. The refund must clip to what elapsed can
  // actually give back — and because the SAME clipped number moves both
  // accumulators, the frontier (elapsed + gap) is unchanged either way.
  const t = nightTimer({ gapSec: 7000, elapsedSec: 200, durationSec: 25200, seedSec: 0 });
  const now = Date.now();
  t.__test.st.updatedAt = now - 60_000;  // banks to gap 6940, elapsed 260
  const frontierBefore = Math.round(t.snapshot().night.frontierSec);
  const sinceMs = now - 600_000;         // an outage anchor far older than the 260s elapsed

  t.pauseRetroactive(sinceMs);

  const s = t.snapshot();
  assert.equal(s.night.elapsedSec, 0, 'the ember cannot be refunded past its own floor');
  assert.equal(Math.round(s.remainingSec), 7200, 'the full elapsed 260 (not the full 600 outage) moved to the gap');
  const frontierAfter = Math.round(s.night.frontierSec);
  assert.equal(frontierAfter, frontierBefore, 'clipping the refund must still conserve the frontier');
});

// ── Fix round 1 (reviewer): defense in depth against night-liveness's own
// check-then-act race, and matching the sibling mutators' return contract ──

test('pauseRetroactive on a night that is already NOT RUNNING is a no-op — a frozen clock owes no refund', () => {
  // night-liveness.js re-checks the timer immediately before calling this,
  // but this is the SECOND, cheaper guard: a caller bug (or a future caller)
  // must not be able to reintroduce the same race. Without it, `dt` would
  // grow with however long the clock sat paused — nothing bounds it to a
  // real outage — while `elapsedSec` sits frozen, fabricating a refund.
  const t = nightTimer({ gapSec: 600, elapsedSec: 3600, durationSec: 25200, seedSec: 0, running: false });
  const before = t.snapshot();

  const result = t.pauseRetroactive(Date.now() - 999_999); // an absurd anchor — must change nothing

  assert.deepEqual(t.snapshot(), before, 'an already-paused night must be completely untouched');
  assert.deepEqual(result, before, 'and must return the (unchanged) snapshot, like every sibling mutator');
});

// ── The SECOND pause against the same anchor ────────────────────────────────

test('a SECOND pauseRetroactive against the same anchor refunds only the time the clock actually RAN since it', () => {
  // Anything that resumes the clock mid-outage — a scene
  // flip off the pre-show scene, a mod hitting play, an OBS sync at startup —
  // leaves night-liveness holding a `lastLiveMs` that is STILL back at the
  // start of the outage (the stream never came back, so nothing refreshed it).
  // The next sustained-outage decision then hands that same anchor over again,
  // and a `dt`-bounded refund would pay the WHOLE outage a second time: the
  // ember rolls backward past truth and the gap grows by funded time nobody
  // streamed.
  //
  // This is the belt to night-liveness's own anchor fix — the refund can only
  // ever be the RUNNING time accrued since `sinceMs`, and a stretch that sat
  // paused owes nothing at all.
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200, seedSec: 0 });
  const now = Date.now();
  t.__test.st.updatedAt = now - 400_000;
  const sinceMs = now - 300_000; // the stream is still down: this anchor never moves

  t.pauseRetroactive(sinceMs);
  const first = t.snapshot();
  assert.equal(Math.round(first.night.elapsedSec), 3700, 'premise: the first pause is the ordinary 300s refund');
  assert.equal(Math.round(first.remainingSec), 4900);

  t.control('play'); // ← the resume that makes a second decision possible
  t.pauseRetroactive(sinceMs); // the SAME stale anchor, a moment later

  const second = t.snapshot();
  assert.equal(Math.round(second.night.elapsedSec), Math.round(first.night.elapsedSec),
    'the ember rolled BACKWARD past truth — the outage was refunded twice');
  assert.equal(Math.round(second.remainingSec), Math.round(first.remainingSec),
    'the gap grew by funded time nobody streamed');
});

test('pauseRetroactive still refunds a genuine second outage — only the stretch the clock RAN', () => {
  // The mirror of the test above: the bound must not turn into "one refund per
  // night". A resumed clock that runs for a real stretch and drops again owes
  // exactly that stretch back, no more.
  const t = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200, seedSec: 0 });
  t.__test.st.updatedAt = Date.now() - 400_000;
  t.pauseRetroactive(Date.now() - 300_000);
  const first = t.snapshot();

  t.control('play');
  // 90 real seconds of clock ran before it dropped again. Both halves of the
  // fiction move together: the anchor the accumulators read from, and the
  // moment the current RUNNING stretch began.
  t.__test.st.updatedAt -= 90_000;
  t.__test.st.runningSinceMs -= 90_000;
  t.pauseRetroactive(Date.now() - 999_999); // an absurd anchor: the bound, not dt, must decide

  const second = t.snapshot();
  // The 90s it ran are exactly what it owes: elapsed 3790 (banked) − 90 = 3700,
  // gap 4810 (banked) + 90 = 4900 — back where the first pause left them.
  assert.equal(Math.round(second.night.elapsedSec), 3700,
    'the 90 unwatched seconds it ran must come back out of the ember (3790 = no refund at all)');
  assert.equal(Math.round(second.remainingSec), 4900,
    'and back onto the gap (4810 = the second outage was never refunded)');
  assert.equal(Math.round(first.night.elapsedSec), 3700, 'premise: this is the first pause\'s value, unmoved');
});

test('pauseRetroactive returns the timerState snapshot, on BOTH branches, like every sibling mutator', () => {
  const active = nightTimer({ gapSec: 5000, elapsedSec: 3600, durationSec: 25200, seedSec: 0 });
  const activeResult = active.pauseRetroactive(Date.now() - 1000);
  assert.deepEqual(activeResult, active.snapshot(), 'the active-night branch must return snapshot()');

  const legacy = createTimer({ broadcast: () => {}, obs: null, pool: null });
  legacy.control('play');
  const legacyResult = legacy.pauseRetroactive(Date.now() - 1000);
  assert.deepEqual(legacyResult, legacy.snapshot(), 'the no-night (control(\'pause\')) branch must also return snapshot()');
});

// ── Edge case: a non-finite donation ────────────────────────────────────────

test('seedSec "" is not a seed of 0 — it is the default, like null', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const evening = Date.UTC(2026, 7, 25, 3, 0, 0); // 2026-08-24 20:00 PDT
  t.startNight({ endLocal: '4am', tz: 'America/Vancouver', now: evening, seedSec: '' });
  assert.equal(t.snapshot().night.seedSec, 7200);
});

test('F-8a: a non-finite donation buys nothing and banks nothing — it cannot wedge persist()', () => {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  const evening = Date.UTC(2026, 7, 25, 3, 0, 0);
  t.startNight({ endLocal: '4am', tz: 'America/Vancouver', now: evening, requiredCentsPerDay: 30000 });
  const before = t.snapshot().night.frontierSec;
  assert.equal(t.addMoney(Infinity), 0);
  assert.equal(t.addMoney(NaN), 0);
  assert.equal(t.snapshot().night.frontierSec, before, 'the frontier did not move');
  assert.equal(t.__test.st.night.overflowCents, 0, 'nothing banked');
});
