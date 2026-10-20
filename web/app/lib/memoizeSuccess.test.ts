// Run: node --test app/lib/memoizeSuccess.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { memoizeSuccess } from "./memoizeSuccess.ts";

test("a resolved value is cached — the factory runs once", async () => {
  let calls = 0;
  const get = memoizeSuccess(async () => { calls += 1; return "stripe"; });
  assert.equal(await get(), "stripe");
  assert.equal(await get(), "stripe");
  assert.equal(calls, 1);
});

test("concurrent callers share ONE in-flight promise", async () => {
  let calls = 0;
  const get = memoizeSuccess(async () => { calls += 1; return calls; });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(calls, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test("a rejection is NOT cached — the next call retries", async () => {
  // A plain `if (!promise) promise = loadStripe(pk)` would pin the rejection,
  // so a viewer whose js.stripe.com failed once could never load it again in
  // that tab — not even after the block or the network recovered.
  let calls = 0;
  const get = memoizeSuccess(async () => {
    calls += 1;
    if (calls === 1) throw new Error("Failed to load Stripe.js");
    return "stripe";
  });
  await assert.rejects(get(), /Failed to load Stripe.js/);
  assert.equal(await get(), "stripe", "second call must re-run the factory");
  assert.equal(calls, 2);
});

test("every caller of a failing load sees the rejection, not a swallowed undefined", async () => {
  // The clearing `.catch` must RE-THROW. If it returned, callers would resolve
  // with undefined and the UI would render a 'ready' Stripe that is not there —
  // the empty-box failure again, one layer down.
  const get = memoizeSuccess(async () => { throw new Error("boom"); });
  await assert.rejects(get(), /boom/);
  await assert.rejects(get(), /boom/);
});

// Vacuity anchor: the module under test really is the one exporting memoizeSuccess.
test("the export under test exists", () => {
  assert.equal(typeof memoizeSuccess, "function");
});
