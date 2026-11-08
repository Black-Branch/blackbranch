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

test("a ban is applied at once and removes their recent lines with it (ticket #228), before the Undo window closes", async () => {
  const r = await modBanAtOnce(msg, 10);
  // The answer names what the ban's purge removed and its batch (none in this fake's answer).
  assert.deepEqual(r, { ok: true, purged: null, batchId: null });
  // The ban's purge takes the clicked line with the rest: no second removal of it.
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban"]);
  assert.equal(calls[0]!.body!.durationMinutes, 10);
  assert.equal(calls[0]!.body!.purge, true, "the ban did not ask for their lines to go");
  // The clicked line goes by its id whatever its age (the purge's window would miss an old one).
  assert.deepEqual(calls[0]!.body!.message, { id: 7, platform: "native" }, "the clicked line was not named to the ban");
  assert.equal(pendingUndos().length, 1, "the Undo is still on offer");
});

test("a held-queue line (synthetic automod: id) bans with the window's purge, and sends no clicked-line delete", async () => {
  await modBanAtOnce({ id: "automod:17", platform: "twitch", matrixId: "@casey:site.test" }, 10);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban"]);
  assert.equal(calls[0]!.body!.purge, true);
});

test("with the switch off, the ban removes only the clicked line, at once", async () => {
  await modBanAtOnce(msg, 10, { purge: false });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban", "POST /api/mod/delete"]);
  assert.equal(calls[0]!.body!.purge, false);
  assert.deepEqual(calls[1]!.body, { messageId: 7, platform: "native" });
});

test("the toast says in plain words what Undo does and does not take back", async () => {
  await modBanAtOnce(msg);
  assert.equal(pendingUndos()[0]!.label, "Ban: done. Undo lifts the ban. Removed messages stay removed.");
  flushUndos();
  await modBanAtOnce(msg, 10);
  assert.equal(pendingUndos()[0]!.label, "Timeout 10m: done. Undo lifts the timeout. Removed messages stay removed.");
});

test("Undo of a fresh ban lifts the ban only: it sends no un-delete", async () => {
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
  assert.equal(back.body!.purge, false, "putting the earlier ban back removed lines again");
  reply = () => ({ ok: true, applied: true, previous: null });
});

test("the window closing sends nothing more: the removal already happened", async () => {
  await modBanAtOnce(msg, 10);
  flushUndos();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban"]);
  assert.equal(pendingUndos().length, 0);
});

test("a kept stronger ban is reported, and nothing is offered to undo", async () => {
  reply = () => ({ ok: true, applied: false, kept: "permanent" });
  const r = await modBanAtOnce(msg, 10);
  assert.deepEqual(r, { ok: false, error: "Kept the existing permanent ban" });
  assert.equal(pendingUndos().length, 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/mod/ban"], "a ban that did not apply removes nothing");
  reply = () => ({ ok: true, applied: true, previous: null });
});

test("the offer ends by itself; a late Undo says so", async () => {
  const id = offerUndo("x", async () => ({ ok: true }), 5);
  assert.equal(pendingUndos().length, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pendingUndos().length, 0);
  assert.deepEqual(await runUndo(id), { ok: false, error: "Too late to undo" });
});
