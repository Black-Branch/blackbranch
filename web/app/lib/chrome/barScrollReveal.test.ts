// The scroll-direction accumulator behind the compact bar's phone-browser
// reveal. Run:
//   node --test app/lib/chrome/barScrollReveal.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createBarScrollReveal, BAR_AUTO_HIDE_MS } from "./barScrollReveal.ts";

function harness(threshold?: number) {
  const calls: string[] = [];
  const m = createBarScrollReveal({
    up: () => calls.push("up"),
    down: () => calls.push("down"),
    threshold,
  });
  return { m, calls };
}

test("accumulates small same-direction deltas to the threshold, then emits once and resets", () => {
  const { m, calls } = harness(12);
  m.delta(-5); m.delta(-5);
  assert.deepEqual(calls, [], "under threshold — no emit");
  m.delta(-5);
  assert.deepEqual(calls, ["up"], "crossing -12 emits up");
  m.delta(-11);
  assert.deepEqual(calls, ["up"], "run reset after the emit — a fresh sub-threshold run stays quiet");
});

test("scrolling down emits down; zero deltas are ignored (a horizontal scroller's scrollTop never moves)", () => {
  const { m, calls } = harness(12);
  m.delta(0); m.delta(0);
  m.delta(8); m.delta(8);
  assert.deepEqual(calls, ["down"]);
});

test("a direction change starts a FRESH run — banked travel one way is not credit for the other", () => {
  const { m, calls } = harness(12);
  m.delta(40);
  assert.deepEqual(calls, ["down"]);
  m.delta(9);           // accumulating down again, under threshold
  m.delta(-11);         // flip: must need a full fresh −12, not −3
  assert.deepEqual(calls, ["down"], "sub-threshold up-run after the flip stays quiet");
  m.delta(-1);
  assert.deepEqual(calls, ["down", "up"]);
});

test("reset() forgets an in-flight run", () => {
  const { m, calls } = harness(12);
  m.delta(-11);
  m.reset();
  m.delta(-11);
  assert.deepEqual(calls, [], "two sub-threshold runs split by reset never merge");
  m.delta(-1);
  assert.deepEqual(calls, ["up"]);
});

test("repeated emits keep flowing on a long run", () => {
  const { m, calls } = harness(10);
  for (let i = 0; i < 5; i++) m.delta(10);
  assert.deepEqual(calls, ["down", "down", "down", "down", "down"]);
});

test("BAR_AUTO_HIDE_MS is the 'couple seconds' contract term", () => {
  assert.equal(BAR_AUTO_HIDE_MS, 2000);
});
