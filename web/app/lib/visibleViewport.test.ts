import { test } from "node:test";
import assert from "node:assert/strict";
// Explicit `.ts` — `node --test` cannot resolve an extensionless TS import,
// and the failure mode is a silently dead suite.
import { clampIntoSpan } from "./visibleViewport.ts";

// The arithmetic behind R-16. `clampToViewport` (userCardLayout) assumes the
// viewport starts at 0; this is the same idiom for a span that starts wherever
// the browser says the visible region currently begins.

test("a box that already fits is left where it is", () => {
  assert.equal(clampIntoSpan(100, 50, 0, 800), 100);
});

test("a box past the bottom is pulled back inside, margin and all", () => {
  // 800-tall span, 200-tall box, 8px margin → the lowest legal top is 592.
  assert.equal(clampIntoSpan(700, 200, 0, 800), 592);
});

test("a box above the top is pushed down to the margin", () => {
  assert.equal(clampIntoSpan(-40, 200, 0, 800), 8);
});

test("an OFFSET span clamps in the same coordinates the box is placed in", () => {
  // iOS-style: the visible region starts 100px down and is 400 tall, so the
  // legal range for a 200-tall box is [108, 292] in layout coordinates.
  assert.equal(clampIntoSpan(0, 200, 100, 400), 108);
  assert.equal(clampIntoSpan(500, 200, 100, 400), 292);
  assert.equal(clampIntoSpan(200, 200, 100, 400), 200);
});

test("a keyboard-shrunk span keeps the box off the keyboard", () => {
  // 900-tall viewport, 400px of keyboard → 500 of visible span. A menu that
  // wanted to open at y=760 (over the keyboard) lands at 500-200-8 = 292.
  assert.equal(clampIntoSpan(760, 200, 0, 500), 292);
});

test("a box TALLER than the span still lands at the top margin, not off-screen", () => {
  // Math.max wins over Math.min: better to overflow downward, where the user
  // can at least see the first rows, than to push the whole thing above the fold.
  assert.equal(clampIntoSpan(50, 600, 0, 300), 8);
});
