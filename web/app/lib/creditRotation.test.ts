// Run: node --test app/lib/creditRotation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCreditList, namesNeedingStyle } from "./creditRotation.ts";

/** The dwell curve, read through its only runtime caller. */
function dwellMsFor(pct: number): number {
  return deriveCreditList([{ name: "x", weightPct: pct, clockRemainSec: 0, clockTotalSec: 0 }])[0]!.dwellMs;
}

// The constants are module-private (an export only a test reads is an orphan);
// the curve's two ends ARE the constants.
const DWELL_MIN_MS = dwellMsFor(0);
const DWELL_MAX_MS = dwellMsFor(100);

test("dwell is linear in share and clamped to [MIN, MAX]", () => {
  assert.equal(DWELL_MIN_MS, 6000, "premise: the floor credit.html uses");
  assert.equal(DWELL_MAX_MS, 14000, "premise: the ceiling credit.html uses");
  assert.equal(dwellMsFor(50), (DWELL_MIN_MS + DWELL_MAX_MS) / 2);
  assert.equal(dwellMsFor(250), DWELL_MAX_MS, "over 100% clamps");
  assert.equal(dwellMsFor(Number.NaN), DWELL_MIN_MS, "garbage reads as 0%");
});

test("deriveCreditList keeps frame order, drops nameless rows, sanitizes numbers", () => {
  const list = deriveCreditList([
    { name: "Eli", weightPct: 60, clockRemainSec: 120, clockTotalSec: 300 },
    { name: "   ", weightPct: 20, clockRemainSec: 0, clockTotalSec: 0 },
    { name: "Dana", weightPct: Number.NaN, clockRemainSec: -5, clockTotalSec: 0 },
  ]);
  assert.deepEqual(list.map((e) => e.name), ["Eli", "Dana"]);
  assert.equal(list[0]!.dwellMs, dwellMsFor(60));
  assert.equal(list[1]!.weightPct, 0);
  assert.equal(list[1]!.clockRemainSec, 0, "a negative remain is 0, never a lit badge");
});

test("an empty or missing pool derives to an empty list (the overlay renders nothing)", () => {
  assert.deepEqual(deriveCreditList([]), []);
  assert.deepEqual(deriveCreditList(null), []);
  assert.deepEqual(deriveCreditList(undefined), []);
});

test("namesNeedingStyle lower-cases, de-dupes, and skips what is already known", () => {
  const list = deriveCreditList([
    { name: "Eli", weightPct: 1, clockRemainSec: 0, clockTotalSec: 0 },
    { name: "eli", weightPct: 1, clockRemainSec: 0, clockTotalSec: 0 },
    { name: "Dana", weightPct: 1, clockRemainSec: 0, clockTotalSec: 0 },
  ]);
  assert.deepEqual(namesNeedingStyle(list, new Set(["dana"])), ["eli"]);
});
