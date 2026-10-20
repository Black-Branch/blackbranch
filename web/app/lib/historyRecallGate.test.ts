// Run: node --test app/lib/historyRecallGate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRecallHistory } from "./historyRecallGate.ts";

// A long single-line draft: no "\n" anywhere, but it wraps onto several visual
// rows in the composer. This is the exact shape that was broken.
const WRAPPED = "this is a long message with absolutely no newline characters in it at all so it wraps";

test("ArrowUp in the MIDDLE of a wrapped draft does NOT recall — the caret must move", () => {
  assert.equal(shouldRecallHistory("ArrowUp", WRAPPED, 40, 40), false);
});

test("ArrowDown in the MIDDLE of a wrapped draft does NOT recall", () => {
  assert.equal(shouldRecallHistory("ArrowDown", WRAPPED, 40, 40), false);
});

test("ArrowUp at the very start DOES recall", () => {
  assert.equal(shouldRecallHistory("ArrowUp", WRAPPED, 0, 0), true);
});

test("ArrowDown at the very end DOES recall", () => {
  assert.equal(shouldRecallHistory("ArrowDown", WRAPPED, WRAPPED.length, WRAPPED.length), true);
});

test("an empty composer recalls in both directions", () => {
  // The everyday case: press Up on an empty box to get your last message back.
  assert.equal(shouldRecallHistory("ArrowUp", "", 0, 0), true);
  assert.equal(shouldRecallHistory("ArrowDown", "", 0, 0), true);
});

test("a selection never recalls — that is a shift-arrow, not a caret move", () => {
  assert.equal(shouldRecallHistory("ArrowUp", WRAPPED, 0, 10), false);
  assert.equal(shouldRecallHistory("ArrowDown", WRAPPED, 5, WRAPPED.length), false);
});

test("an explicit newline still behaves: recall only from the true ends", () => {
  const multi = "first line\nsecond line";
  assert.equal(shouldRecallHistory("ArrowUp", multi, 0, 0), true, "start of line 1");
  assert.equal(shouldRecallHistory("ArrowUp", multi, 15, 15), false, "inside line 2 must move the caret");
  assert.equal(shouldRecallHistory("ArrowDown", multi, multi.length, multi.length), true, "end of line 2");
  assert.equal(shouldRecallHistory("ArrowDown", multi, 3, 3), false, "inside line 1 must move the caret");
});

// Vacuity anchor at the END: the gate must actually discriminate, not return
// one constant. Two calls differing in ONE argument must differ in result.
test("the gate discriminates on caret position alone", () => {
  assert.notEqual(
    shouldRecallHistory("ArrowUp", WRAPPED, 0, 0),
    shouldRecallHistory("ArrowUp", WRAPPED, 40, 40),
  );
});
