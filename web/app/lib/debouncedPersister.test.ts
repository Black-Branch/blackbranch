// Tests for the trailing-debounce writer behind the floating Window's geometry save.
// Dependency-free (node --test, mock timers — no DOM).
//
// Run: node --test app/lib/debouncedPersister.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createDebouncedPersister } from "./debouncedPersister.ts";

test("does not write until the delay elapses", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.schedule(1);
  t.mock.timers.tick(299);
  assert.deepEqual(writes, [], "wrote before the debounce elapsed");
  t.mock.timers.tick(1);
  assert.deepEqual(writes, [1]);
});

test("coalesces a burst into one write of the LAST value", (t) => {
  // A drag fires a pointermove (and so a schedule) per frame; only the final
  // resting position should ever reach storage.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.schedule(1);
  t.mock.timers.tick(100);
  p.schedule(2);
  t.mock.timers.tick(100);
  p.schedule(3);
  t.mock.timers.tick(300);

  assert.deepEqual(writes, [3]);
});

test("flush() writes the pending value immediately", (t) => {
  // THE REGRESSION TEST. This is the profile-card bug: the panel unmounted
  // inside the debounce window and the drag was lost. flush() on unmount (and
  // on pointer-up) is what makes the move survive.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.schedule(42);
  assert.equal(p.isPending(), true);
  p.flush();

  assert.deepEqual(writes, [42], "flush did not write the pending value");
  assert.equal(p.isPending(), false);
});

test("flush() does not double-write when the timer would also have fired", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.schedule(7);
  p.flush();
  t.mock.timers.tick(1000);

  assert.deepEqual(writes, [7], "the cancelled timer fired a second write");
});

test("flush() with nothing pending is a no-op", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.flush();
  p.schedule(1);
  t.mock.timers.tick(300);
  p.flush();

  assert.deepEqual(writes, [1], "flush wrote a phantom value");
});

test("cancel() discards the pending value without writing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: number[] = [];
  const p = createDebouncedPersister<number>((v) => writes.push(v), 300);

  p.schedule(9);
  p.cancel();
  t.mock.timers.tick(1000);

  assert.deepEqual(writes, []);
  assert.equal(p.isPending(), false);
});

test("a falsy value is still a real pending value", (t) => {
  // Guards the boxed-pending detail: `pending = value` with a `0`/null payload
  // would read as "nothing pending" and silently skip the write.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const writes: unknown[] = [];
  const p = createDebouncedPersister<number | null>((v) => writes.push(v), 300);

  p.schedule(0);
  p.flush();
  p.schedule(null);
  p.flush();

  assert.deepEqual(writes, [0, null]);
});
