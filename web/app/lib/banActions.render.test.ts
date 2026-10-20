// Bans, as a mod meets them (owner's decision): the panel form starts on a 10-minute timeout with
// a reason field and a button that names the action; only a permanent ban asks to be confirmed.
// The user card's timeout and ban act at once with an Undo (the message removed only when the Undo
// window closes); its permanent ban asks first.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/banActions.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
// The card's name fitting reads computed styles, a window global jsdom keeps on its window.
(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// next/link's prefetch observer schedules through `self`.
(globalThis as unknown as { self: unknown }).self = globalThis;
const { default: BanSection } = await import("@/app/features/moderation/sections/BanSection");
const { default: UserCard } = await import("@/app/components/UserCard");
const { pendingUndos, flushUndos } = await import("./modUndo.ts");
const { default: HistorySection } = await import("@/app/features/moderation/sections/HistorySection");
const { default: ModUndoToast } = await import("@/app/components/ModUndoToast");
const { trackPropagation } = await import("./modPropagation.ts");
const { createRoot } = await import("react-dom/client");

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

function serve(routes: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => String(url).startsWith(k));
    return Promise.resolve(new Response(JSON.stringify(key ? routes[key] : {}), { status: 200, headers: { "content-type": "application/json" } }));
  };
  return calls;
}

const posts = (calls: Call[], url: string) => calls.filter((c) => c.url === url && c.method !== "GET");

function button(re: RegExp): HTMLButtonElement | null {
  return ([...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => re.test(b.textContent ?? "") || re.test(b.getAttribute("aria-label") ?? "")) ?? null;
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function mount(el: React.ReactElement) {
  resetStorage();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, cleanup: () => act(async () => { root.unmount(); host.remove(); }) };
}

// ─── The Bans form ───────────────────────────────────────────────────────────

test("the form starts on a 10-minute timeout, names it on the button, and sends the reason", async () => {
  const calls = serve({ "/api/mod/bans": { bans: [] }, "/api/mod/ban": { ok: true, applied: true } });
  const { host, cleanup } = await mount(React.createElement(BanSection, { note: () => {}, initialTarget: "@casey:site.test" }));
  const select = host.querySelector("select") as HTMLSelectElement;
  assert.equal(select.value, "10", "the form defaulted to something other than a 10-minute timeout");
  assert.ok(button(/^Time out 10m$/), "the button does not say what it will do");
  await act(async () => { setValue(host.querySelector('input[aria-label="Reason"]') as HTMLInputElement, "spam links"); });
  await act(async () => { button(/^Time out 10m$/)!.click(); });
  const [sent] = posts(calls, "/api/mod/ban");
  assert.deepEqual(sent?.body, { targetId: "@casey:site.test", override: false, durationMinutes: 10, reason: "spam links" });
  await cleanup();
});

test("a permanent ban from the form asks first; nothing is sent until it is confirmed", async () => {
  const calls = serve({ "/api/mod/bans": { bans: [] }, "/api/mod/ban": { ok: true, applied: true } });
  const { host, cleanup } = await mount(React.createElement(BanSection, { note: () => {}, initialTarget: "@casey:site.test" }));
  await act(async () => { setValue(host.querySelector("select") as HTMLSelectElement, "perm"); });
  await act(async () => { button(/^Ban permanently$/)!.click(); });
  assert.equal(posts(calls, "/api/mod/ban").length, 0, "a permanent ban went out on one press");
  assert.ok(button(/^Confirm permanent ban\?$/));
  await act(async () => { button(/^Confirm permanent ban\?$/)!.click(); });
  const sent = posts(calls, "/api/mod/ban");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body?.durationMinutes, undefined, "permanent means no duration");
  await cleanup();
});

test("a ban that did not land on a platform is marked ✗ on its Bans row", async () => {
  serve({ "/api/mod/bans": { bans: [{ matrixId: "@casey:site.test", targetName: "casey", bannedBy: "@mod:site.test", modName: null,
    reason: null, expiresAt: null, createdAt: new Date().toISOString(), failedPlatforms: ["kick"] }] } });
  const { host, cleanup } = await mount(React.createElement(BanSection, { note: () => {} }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(host.textContent ?? "", /✗ Kick/);
  await cleanup();
});

// ─── The user card ───────────────────────────────────────────────────────────

const MSG = { id: 42, platform: "native", username: "casey", text: "hi", matrixId: "@casey:site.test" };

async function openCardTools() {
  const calls = serve({
    "/api/mod/ban": { ok: true, applied: true, previous: null, batchId: "11111111-1111-1111-1111-111111111111", platforms: [] },
    "/api/mod/platform-actions": { actions: [] },
    "/api/mod/chat-history": { messages: [] },
  });
  const card = await mount(React.createElement(UserCard, { msg: MSG, isMod: true, onClose: () => {} } as never));
  await act(async () => { button(/Identity, history/)!.click(); });
  return { calls, ...card };
}

test("the card's ⏱ times out for 10 minutes at once, with an Undo; the message goes only when the Undo window closes", async () => {
  const { calls, cleanup } = await openCardTools();
  await act(async () => { button(/^Time out for 10m$/)!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const sent = posts(calls, "/api/mod/ban");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body?.durationMinutes, 10);
  assert.equal(pendingUndos().length, 1, "no Undo was offered");
  assert.equal(posts(calls, "/api/mod/delete").length, 0, "the message was removed before the Undo window closed");
  flushUndos();
  assert.equal(posts(calls, "/api/mod/delete").length, 1);
  await cleanup();
});

test("the card's 🔨 is a PERMANENT ban: it asks first, then bans at once with an Undo", async () => {
  const { calls, cleanup } = await openCardTools();
  await act(async () => { button(/^Ban permanently$/)!.click(); });
  assert.equal(posts(calls, "/api/mod/ban").length, 0, "one tap banned permanently");
  await act(async () => { button(/^Confirm: ban permanently\?$/)!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const sent = posts(calls, "/api/mod/ban");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body?.durationMinutes, undefined);
  assert.equal(pendingUndos().length, 1);
  flushUndos();
  await cleanup();
});

// ─── Which platforms it reached ──────────────────────────────────────────────

test("a Mod history row whose action failed on a platform carries the ✗", async () => {
  serve({ "/api/mod/log": { entries: [{ id: 1, action: "ban", targetId: "@casey:site.test", targetName: "casey", performedBy: "@mod:site.test",
    modName: null, durationMinutes: null, expiresAt: null, reason: null, batchId: "b", failedPlatforms: ["kick", "youtube"], at: new Date().toISOString() }] } });
  const { host, cleanup } = await mount(React.createElement(HistorySection, { note: () => {} }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.match(host.textContent ?? "", /✗ Kick, YouTube/);
  await cleanup();
});

test("after an action, ONE status line names each platform, and its Retry re-runs the failure", async () => {
  const calls = serve({
    "/api/mod/platform-actions/retry": { ok: true },
    "/api/mod/platform-actions": { actions: [
      { id: 1, platform: "twitch", action: "ban", ok: true, status: null, detail: null },
      { id: 2, platform: "kick", action: "ban", ok: false, status: null, detail: "no_capable_token" },
    ] },
  });
  const { cleanup } = await mount(React.createElement(ModUndoToast));
  await act(async () => { trackPropagation("Ban", { batchId: "b", platforms: ["twitch", "kick"] }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  // (Earlier tests' actions may still be listed; this action's line is the one that names Twitch.)
  const line = [...dom.window.document.querySelectorAll("[data-propagation]")].find((e) => /Twitch/.test(e.textContent ?? ""));
  assert.equal(line?.textContent, "Ban: Twitch ✓ · Kick ✗ (missing scope)Retry");
  await act(async () => { (line!.querySelector("button") as HTMLButtonElement).click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.deepEqual(posts(calls, "/api/mod/platform-actions/retry").map((c) => c.body), [{ id: 2 }]);
  await cleanup();
});
