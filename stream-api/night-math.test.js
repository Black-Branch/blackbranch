'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const NM = require('./night-math.js');

test('weights ramp 0.8→1.7 with the knee at 60%', () => {
  const w = NM.makeWeights(6);
  assert.equal(w.length, 6);
  assert.ok(Math.abs(w[0] - 0.8) < 1e-9);
  assert.ok(Math.abs(w[5] - 1.7) < 1e-9);
  for (let i = 1; i < 6; i++) assert.ok(w[i] > w[i-1]);
  assert.deepEqual(NM.makeWeights(1), [1]);
});
test('night price: $24/h floor vs required', () => {
  // eslint-disable-next-line no-constant-condition -- brief's verbatim ternary, kept exactly as specced
  assert.equal(NM.nightPriceCents(8*3600, 20000), 20000 < 2400*8 ? 2400*8 : 20000); // floor≥
  assert.equal(NM.nightPriceCents(8*3600, 36200), 36200);                            // required wins
  assert.equal(NM.nightPriceCents(8*3600, 0), 19200);                                // no snapshot
});
test('layout: blocks tile seed→duration and sum EXACTLY to the price', () => {
  const b = NM.layoutBlocks(8*3600, 2*3600, 36200);
  assert.equal(b.length, 6);
  assert.equal(b[0].startSec, 7200);
  assert.equal(b.at(-1).startSec + b.at(-1).lenSec, 8*3600);
  assert.equal(b.reduce((s, x) => s + x.cents, 0), 36200);
  assert.ok(b.at(-1).cents > b[0].cents * 1.9); // 1.7/0.8 ≳ 2 — the curve is real
});
test('conversion integrates across block boundaries', () => {
  const b = NM.layoutBlocks(4*3600, 0, 4000); // 4 blocks
  const r = NM.convertCents(b[0].cents + b[1].cents, 0, b, 4*3600);
  assert.equal(r.seconds, 7200); // exactly two blocks
  assert.equal(r.overflowCents, 0);
});
test('deficit-first is just integrate-from-frontier (law 7)', () => {
  const b = NM.layoutBlocks(4*3600, 0, 4000);
  // frontier at 30min, ember (elsewhere) at 60min — conversion starts at the FRONTIER
  const r = NM.convertCents(b[0].cents / 2, 1800, b, 4*3600);
  assert.equal(r.seconds, 1800);
});
test('gold: everything past duration is overflow; encore drains it at the flat final rate', () => {
  const b = NM.layoutBlocks(2*3600, 0, 2000);
  const r = NM.convertCents(2000 + 500, 0, b, 2*3600);
  assert.equal(r.seconds, 2*3600);
  assert.equal(r.overflowCents, 500);
  const b2 = NM.extendBlocks(b, 3600);
  const finalRate = b.at(-1).cents / b.at(-1).lenSec;
  assert.equal(b2.at(-1).cents, Math.round(finalRate * 3600));
  const d = NM.drainOverflow(500, 2*3600, b2, 3*3600);
  assert.equal(d.seconds, Math.round(500 / finalRate));
});

// ── caller-contract guards ──────────────────────────────────────────────────

test('a frontier below the first sellable block throws instead of pricing the free seed', () => {
  // Without the guard this buys 2h1s for a single cent — the seed region
  // (0..7200 here) is silently priced when the frontier starts at 0
  // instead of at seedSec. The timer always starts the frontier at seedSec,
  // so a lower frontier is a caller bug, not a state to handle.
  const b = NM.layoutBlocks(8*3600, 2*3600, 36200);
  assert.throws(
    () => NM.convertCents(1, 0, b, 8*3600),
    /frontierSec below first sellable block/
  );
});

test('blocks extending past durationSec throws instead of stranding the extra time as overflow', () => {
  // The exact stale-duration shape: extend the blocks by 3600s but do not
  // widen durationSec by the same amount. Without this guard, draining the
  // overflow into the extended block silently buys nothing (the walk
  // stops at the stale durationSec) and hands the whole 500c back as
  // overflowCents — money for nothing, with no error.
  const b = NM.layoutBlocks(2*3600, 0, 2000);
  const b2 = NM.extendBlocks(b, 3600);
  assert.throws(
    () => NM.drainOverflow(500, 2*3600, b2, 2*3600),
    /blocks extend past durationSec/
  );
});

test('extendBlocks on an empty array throws a named error, not a bare TypeError', () => {
  assert.throws(
    () => NM.extendBlocks([], 3600),
    /extendBlocks: no existing blocks to price from/
  );
});

test('makeWeights(0) is the empty array — the contract is length n, always', () => {
  assert.deepEqual(NM.makeWeights(0), []);
});
