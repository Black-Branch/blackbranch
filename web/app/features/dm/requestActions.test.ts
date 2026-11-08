// A DM request's Block: hide the person everywhere (the hide list reaches the Matrix ignore list,
// which the server enforces), then decline the request — one plain line per outcome.
// Run: node --test app/features/dm/requestActions.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../../lib/testTsx.ts";
import type { HideResult } from "../../lib/behaviorStore.ts";

const { blockRequest } = await import("./requestActions.ts");
const { personOfMessage } = await import("../../lib/hideTarget.ts");

const ME = { matrixId: "@me:site.test", ownIds: [] as string[] };
const target = personOfMessage({ username: "casey", matrixId: "@casey:site.test" })!;

async function run(result: HideResult, declineFails = false) {
  const hides: unknown[][] = [];
  let declines = 0;
  const out = await blockRequest(target, ME, async () => { declines += 1; if (declineFails) throw new Error("M_FORBIDDEN"); },
    async (...a: unknown[]) => { hides.push(a); return result; });
  return { out, hides, declines };
}

test("Block calls hidePerson with the matrix id, then declines the request", async () => {
  const { out, hides, declines } = await run("hidden");
  assert.deepEqual(hides, [[{ id: "@casey:site.test", name: "casey", matrixId: "@casey:site.test" }, ME]]);
  assert.equal(declines, 1);
  assert.deepEqual(out, { line: "Blocked — undo in Settings › Behavior", blocked: true });
});

test("already hidden reads the same, and still declines", async () => {
  const { out, declines } = await run("already");
  assert.deepEqual(out, { line: "Blocked — undo in Settings › Behavior", blocked: true });
  assert.equal(declines, 1);
});

test("`full` shows its line and keeps the request", async () => {
  const { out, declines } = await run("full");
  assert.deepEqual(out, { line: "Your hidden list is full — remove someone in Settings › Behavior", blocked: false });
  assert.equal(declines, 0);
});

test("`failed` shows its line and keeps the request", async () => {
  const { out, declines } = await run("failed");
  assert.deepEqual(out, { line: "Couldn't block — try again", blocked: false });
  assert.equal(declines, 0);
});

test("`self` shows its line", async () => {
  const { out, declines } = await run("self");
  assert.deepEqual(out, { line: "That's you — there is no one to block", blocked: false });
  assert.equal(declines, 0);
});

test("a decline that fails after the hide still reads Blocked (the server already refuses them)", async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const { out } = await run("hidden", true);
    assert.deepEqual(out, { line: "Blocked — undo in Settings › Behavior", blocked: true });
  } finally { console.warn = orig; }
});
