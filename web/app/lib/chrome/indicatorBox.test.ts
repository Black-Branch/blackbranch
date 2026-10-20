// Run: node --test app/lib/chrome/indicatorBox.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpolateBox, type Box } from "./indicatorBox.ts";

const boxes: Box[] = [
  { x: 0, w: 40 },
  { x: 40, w: 60 },
  { x: 100, w: 30 },
];

test("no progress: returns the active box unchanged", () => {
  assert.deepEqual(interpolateBox(boxes, 0), { x: 0, w: 40 });
  assert.deepEqual(interpolateBox(boxes, 1), { x: 40, w: 60 });
  assert.deepEqual(interpolateBox(boxes, 2), { x: 100, w: 30 });
});

test("progress exactly on an index behaves like the active lookup", () => {
  assert.deepEqual(interpolateBox(boxes, 0, 1), { x: 40, w: 60 });
});

test("progress at the midpoint lerps x and w evenly between neighbours", () => {
  assert.deepEqual(interpolateBox(boxes, 0, 0.5), { x: 20, w: 50 });
  assert.deepEqual(interpolateBox(boxes, 0, 1.5), { x: 70, w: 45 });
});

test("progress is clamped below the range to the first box", () => {
  assert.deepEqual(interpolateBox(boxes, 0, -5), { x: 0, w: 40 });
});

test("progress is clamped above the range to the last box", () => {
  assert.deepEqual(interpolateBox(boxes, 0, 99), { x: 100, w: 30 });
});

test("empty boxes: always null, progress or not", () => {
  assert.equal(interpolateBox([], 0), null);
  assert.equal(interpolateBox([], 0, 0.5), null);
});

test("a null neighbour falls back to the lower box instead of interpolating", () => {
  const withHole: (Box | null)[] = [{ x: 0, w: 40 }, null, { x: 100, w: 30 }];
  assert.deepEqual(interpolateBox(withHole, 0, 0.5), { x: 0, w: 40 });
  // the "lo" box itself unmeasured: nothing to fall back to
  assert.equal(interpolateBox(withHole, 0, 1.5), null);
});

test("active out of bounds with no progress: null, not a throw", () => {
  assert.equal(interpolateBox(boxes, 9), null);
});
