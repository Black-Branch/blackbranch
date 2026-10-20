// web/app/lib/chrome/tabListKeys.test.ts
// The WAI-ARIA tabs keyboard model, pure. Run: node --test app/lib/chrome/tabListKeys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { moveIndex, activeIndex } from "./tabListKeys.ts";

test("ArrowRight / ArrowLeft move and WRAP at the ends (horizontal)", () => {
  assert.equal(moveIndex(0, "ArrowRight", 3), 1);
  assert.equal(moveIndex(2, "ArrowRight", 3), 0);
  assert.equal(moveIndex(0, "ArrowLeft", 3), 2);
  assert.equal(moveIndex(1, "ArrowLeft", 3), 0);
});

test("Home / End jump to the first / last tab", () => {
  assert.equal(moveIndex(1, "Home", 4), 0);
  assert.equal(moveIndex(1, "End", 4), 3);
});

test("vertical rails answer ArrowUp / ArrowDown and ignore the horizontal arrows", () => {
  assert.equal(moveIndex(0, "ArrowDown", 3, "vertical"), 1);
  assert.equal(moveIndex(0, "ArrowUp", 3, "vertical"), 2);
  assert.equal(moveIndex(0, "ArrowRight", 3, "vertical"), null);
  assert.equal(moveIndex(0, "ArrowDown", 3, "horizontal"), null);
});

test("a key the model does not own returns null so the event is left alone", () => {
  assert.equal(moveIndex(0, "Tab", 3), null);
  assert.equal(moveIndex(0, "Enter", 3), null);
  assert.equal(moveIndex(0, "a", 3), null);
});

test("an empty list never moves", () => {
  assert.equal(moveIndex(0, "ArrowRight", 0), null);
  assert.equal(moveIndex(0, "Home", 0), null);
});

test("activeIndex finds the value, and falls back to 0 so EXACTLY ONE tab is always selected", () => {
  assert.equal(activeIndex(["a", "b", "c"], "b"), 1);
  assert.equal(activeIndex(["a", "b", "c"], "zzz"), 0);
  assert.equal(activeIndex([], "a"), 0);
});
