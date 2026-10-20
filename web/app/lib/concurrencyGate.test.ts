// The concurrency gate shared by the media relay and ensureStripeCustomer.
import test from "node:test";
import assert from "node:assert/strict";
import { createConcurrencyGate } from "./concurrencyGate.ts";

test("the gate admits up to its bound, queues the next, and hands a freed slot on", async () => {
  const gate = createConcurrencyGate({ maxConcurrent: 2, maxQueued: 1, maxWaitMs: 1000 });
  const a = await gate.acquire();
  const b = await gate.acquire();
  assert.ok(a && b);
  let cGot = false;
  const c = gate.acquire().then((r) => { cGot = true; return r; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cGot, false, "a third relay waits while two run");
  assert.equal(await gate.acquire(), null, "the queue is full — refuse rather than pile up");
  a!();
  const cr = await c;
  assert.ok(cr, "the freed slot goes to the waiter");
  b!(); cr!();
  assert.ok(await gate.acquire(), "and slots come back");
});

test("a waiter that is not served in time gets null and does not take a slot later", async () => {
  const gate = createConcurrencyGate({ maxConcurrent: 1, maxQueued: 4, maxWaitMs: 30 });
  const a = await gate.acquire();
  assert.equal(await gate.acquire(), null);
  a!();
  const again = await gate.acquire();
  assert.ok(again, "the timed-out waiter must not have consumed the slot");
});
