// ⑥ Community: the stable alternating stripe and the group ends (mxRows.ts).
// Run: node --test app/lib/mxRows.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { stripes, groupEnds } from "./mxRows.ts";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

test("a fresh list alternates from the top", () => {
  assert.deepEqual(stripes(rows(4)), [false, true, false, true]);
  assert.deepEqual(stripes([]), []);
});

test("rows arriving below never re-stripe the rows already on screen", () => {
  const r = rows(3);
  const before = stripes(r);
  const more = [...r, { i: 3 }, { i: 4 }];
  const after = stripes(more);
  assert.deepEqual(after.slice(0, 3), before);
  assert.deepEqual(after.slice(3), [!before[2], before[2]]);
});

test("rows paged in ABOVE (scroll-back) take the stripe from below, and nothing visible changes", () => {
  const visible = rows(3);
  const before = stripes(visible);
  const older = [{ i: -2 }, { i: -1 }];
  const after = stripes([...older, ...visible]);
  assert.deepEqual(after.slice(2), before, "the rows already shown kept their colours");
  assert.equal(after[1], !before[0]);
  assert.equal(after[0], before[0]);
});

test("the window sliding off the top keeps every remaining stripe", () => {
  const r = rows(5);
  const before = stripes(r);
  assert.deepEqual(stripes(r.slice(2)), before.slice(2));
});

test("groupEnds: a row is the last of its group when the next one does not continue it", () => {
  // groups: [0,1] [2] [3,4,5]
  const cont = [false, true, false, false, true, true];
  assert.deepEqual(groupEnds(6, (i) => cont[i]!), [false, true, true, false, false, true]);
  assert.deepEqual(groupEnds(0, () => false), []);
});
