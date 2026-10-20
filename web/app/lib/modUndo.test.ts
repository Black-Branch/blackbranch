// Act at once with an Undo. fetch is stubbed: nothing leaves the process.
// Run: node --test app/lib/modUndo.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { offerUndo, runUndo, pendingUndos, flushUndos } from "./modUndo.ts";
import { modBanAtOnce, undoPlan } from "./modQuickActions.ts";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined; keepalive: boolean };
let calls: Call[] = [];
let reply: (c: Call) => unknown = () => ({ ok: true, applied: true, previous: null });
beforeEach(() => {
  flushUndos();
  calls = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined, keepalive: !!init.keepalive };
    calls.push(c);
    return new Response(JSON.stringify(reply(c)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

const msg = { id: 7, platform: "native", matrixId: "@casey:site.test" };

test("undo plan: no earlier ban → lift; a permanent one → put back; a timeout with time left → put back for what is left", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  assert.deepEqual(undoPlan(null, now), { kind: "lift" });
  assert.deepEqual(undoPlan({ expiresAt: null }, now), { kind: "restore", minutes: null });
  assert.deepEqual(undoPlan({ expiresAt: "2026-10-12T00:09:30Z" }, now), { kind: "restore", minutes: 10 });
  assert.deepEqual(undoPlan({ expiresAt: "2026-10-11T23:59:00Z" }, now), { kind: "lift" }, "an earlier timeout already over");
});

test("a ban is applied at once, the message is NOT removed yet, and an Undo is offered", async () => {
  const r = await modBanAtOnce(msg, 10);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban"]);
  assert.equal(calls[0]!.body!.durationMinutes, 10);
  assert.equal(pendingUndos().length, 1);
});

test("Undo of a fresh ban lifts it, and the message is never removed", async () => {
  await modBanAtOnce(msg);
  const r = await runUndo(pendingUndos()[0]!.id);
  assert.deepEqual(r, { ok: true });
  flushUndos();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban", "DELETE /api/mod/ban"]);
  assert.deepEqual(calls[1]!.body, { targetId: "@casey:site.test" });
});

test("Undo of a timeout that extended an earlier one puts the earlier one back (override), not a lift", async () => {
  reply = () => ({ ok: true, applied: true, previous: { expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() } });
  await modBanAtOnce(msg, 60);
  await runUndo(pendingUndos()[0]!.id);
  const back = calls[1]!;
  assert.equal(back.method, "POST");
  assert.equal(back.body!.override, true);
  assert.equal(back.body!.durationMinutes, 5);
  reply = () => ({ ok: true, applied: true, previous: null });
});

test("without an Undo the message is removed when the window closes — with keepalive when the page is leaving", async () => {
  await modBanAtOnce(msg, 10);
  flushUndos();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban", "POST /api/mod/delete"]);
  assert.equal(calls[1]!.keepalive, true);
  assert.equal(pendingUndos().length, 0);
});

test("a kept stronger ban is reported, and nothing is offered to undo", async () => {
  reply = () => ({ ok: true, applied: false, kept: "permanent" });
  const r = await modBanAtOnce(msg, 10);
  assert.deepEqual(r, { ok: false, error: "Kept the existing permanent ban" });
  assert.equal(pendingUndos().length, 0);
  reply = () => ({ ok: true, applied: true, previous: null });
});

test("the offer ends by itself and runs its commit; a late Undo says so", async () => {
  let committed = 0;
  const id = offerUndo("x", async () => ({ ok: true }), () => { committed++; }, 5);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(committed, 1);
  assert.deepEqual(await runUndo(id), { ok: false, error: "Too late to undo" });
});
