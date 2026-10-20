// The chat commands keep their meaning (owner's decision, review round 4): `/ban` is permanent —
// the word says it — and `/timeout` defaults to 10 minutes. Driven through the real runner.
// Run: node --test app/lib/commands/banCommands.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import "../testTsx.ts";

const { createCommandRunner } = await import("./run.ts");

function stub() {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/mod/ban") bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, applied: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return bodies;
}
const mod = { isMod: true, isAdmin: false };
const runner = () => createCommandRunner({ setSendError: () => {}, showNotice: () => {} }).runCommand;

test("/ban is permanent: no duration is sent", async () => {
  const bodies = stub();
  await runner()("/ban casey being awful", mod);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.durationMinutes, undefined);
  assert.equal(bodies[0]!.reason, "being awful");
});

test("/timeout defaults to 10 minutes; a typed length wins", async () => {
  const bodies = stub();
  await runner()("/timeout casey", mod);
  await runner()("/timeout casey 2h", mod);
  assert.deepEqual(bodies.map((b) => b.durationMinutes), [10, 120]);
});
