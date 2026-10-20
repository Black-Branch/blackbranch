// The tab's beat, RENDERED: what it sends, when it sends again, and that it
// stands down on a 401 instead of hammering a signed-out session.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/usePresenceBeat.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook } from "./testDom.ts";
import { usePresenceBeat, __resetPresenceBeatForTests } from "./usePresenceBeat.ts";

// node --test realm gotcha (useUserMenuEvents.test.ts precedent, also hit by
// useKeyboardLift.render.test.ts): the hook constructs `new CustomEvent(...)`
// against NODE's global CustomEvent, and jsdom's dispatchEvent rejects an
// event from another realm. Point the global at jsdom's constructor before
// any test dispatches a beat.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = dom.window.CustomEvent;

type Sent = { url: string; body: Record<string, unknown> };

function harness(status = 200) {
  const sent: Sent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "online", statusText: "" }), { status }));
  };
  const schedule = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  return { sent, timers, fetchImpl, schedule };
}

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(dom.window.document, "visibilityState", { value: v, configurable: true });
}

test("mount → one immediate beat with the coarse page, the community flag and visibility; next beat scheduled at 30 s", async () => {
  __resetPresenceBeatForTests();
  setVisibility("visible");
  const h = harness();
  const m = await mountHook(() => usePresenceBeat({ community: true, pathname: "/community/!room:site.test", schedule: h.schedule, fetchImpl: h.fetchImpl }));
  await m.act(async () => {});
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]?.url, "/api/presence/beat");
  assert.deepEqual(h.sent[0]?.body, { page: "community", community: true, visible: true });
  assert.equal(h.timers[0]?.ms, 30_000, "visible cadence");
  await m.unmount();
});

test("hidden tab → the beat says visible:false and the next one waits 60 s; coming back fires at once", async () => {
  __resetPresenceBeatForTests();
  setVisibility("hidden");
  const h = harness();
  const m = await mountHook(() => usePresenceBeat({ community: false, pathname: "/", schedule: h.schedule, fetchImpl: h.fetchImpl }));
  await m.act(async () => {});
  assert.deepEqual(h.sent[0]?.body, { page: "stream", community: false, visible: false });
  assert.equal(h.timers[0]?.ms, 60_000, "hidden cadence");
  setVisibility("visible");
  await m.act(async () => { dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")); });
  assert.equal(h.sent.length, 2, "returning to the tab beats immediately");
  assert.equal(h.sent[1]?.body.visible, true);
  await m.unmount();
});

test("a beat whose response carries a changed status dispatches bb:presence-status once; a repeat of the same status dispatches nothing", async () => {
  __resetPresenceBeatForTests();
  setVisibility("visible");
  const sent: Sent[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "idle", statusText: "" }), { status: 200 }));
  };
  const schedule = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  const seen: unknown[] = [];
  const onStatus = (e: Event) => seen.push((e as CustomEvent<{ status?: unknown }>).detail?.status);
  dom.window.addEventListener("bb:presence-status", onStatus);
  const m = await mountHook(() => usePresenceBeat({ community: false, pathname: "/", schedule, fetchImpl }));
  // The real Response.json() reads its body over more than one microtask —
  // a bare `act(async () => {})` isn't enough to observe it resolve.
  await m.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(seen, ["idle"], "the first beat's status differs from the unset default, so it dispatches once");
  // A second beat (same server response) must not dispatch again — nothing changed.
  await m.act(async () => { timers[0]?.fn(); await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(seen, ["idle"], "a repeat of the same status dispatches nothing");
  dom.window.removeEventListener("bb:presence-status", onStatus);
  await m.unmount();
});

test("a 401 stands the beat down for the rest of the page life — no retry loop against a signed-out session", async () => {
  __resetPresenceBeatForTests();
  setVisibility("visible");
  const h = harness(401);
  const m = await mountHook(() => usePresenceBeat({ community: false, pathname: "/", schedule: h.schedule, fetchImpl: h.fetchImpl }));
  await m.act(async () => {});
  assert.equal(h.sent.length, 1);
  await m.act(async () => { h.timers[0]?.fn(); });
  assert.equal(h.sent.length, 1, "the scheduled beat must not fire after a 401");
  await m.unmount();
});
