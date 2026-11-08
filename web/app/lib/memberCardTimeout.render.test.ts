// The member card's Timeout (spec 2026-10-23 §4.11): only a site mod or admin sees it, never on
// their own card or a Discord member's; one length from the fixed list, a reason before it can be
// sent, then one POST to /api/mod/timeout.
//
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/memberCardTimeout.render.test.ts

import "./testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";

installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

// Node's Response, routed by URL (memberCardActions.render.test.ts says why).
function serve(isMod: boolean, timeout: { status: number; body: unknown }) {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const u = String(url);
    const [status, body] = u.startsWith("/api/me") ? [200, { signedIn: true, isMod }]
      : u.startsWith("/api/presence") ? [200, { counts: { onSite: 0, inCommunity: 0 }, users: {} }]
      : u.startsWith("/api/mod/timeout") ? [timeout.status, timeout.body]
      : [200, {}];
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  };
  return calls;
}

function member(userId: string, powerLevel = 0) {
  return {
    userId, powerLevel, membership: "join",
    name: userId.slice(1).split(":")[0], rawDisplayName: userId.slice(1).split(":")[0],
    getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}) } },
  };
}

function room(viewerPower: number) {
  return {
    roomId: "!general:example.tv", name: "general",
    client: { getUser: () => null, getAccountData: () => undefined, kick: async () => ({}), ban: async () => ({}), unban: async () => ({}) },
    getDMInviter: () => undefined,
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) => (id === "@mod:example.tv" ? member(id, viewerPower) : member(id)),
  };
}

const button = (re: RegExp) =>
  ([...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => re.test(b.textContent ?? "")) ?? null;

function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

// A failed assertion skips a test's own cleanup; a card left mounted keeps the process alive.
const open: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const c of open.splice(0)) await c(); });

async function render(target: string, opts: { isMod?: boolean; viewerPower?: number; timeout?: { status: number; body: unknown } } = {}) {
  resetStorage();
  const calls = serve(opts.isMod ?? true, opts.timeout ?? { status: 200, body: { ok: true, applied: true, until: "2026-10-23T13:00:00Z" } });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const r = room(opts.viewerPower ?? 50);
  await act(async () => {
    root.render(React.createElement(MemberCard, {
      member: member(target), room: r, x: 10, y: 10, side: "left", color: "#fff",
      canMessage: false, onMessage: () => {}, onClose: () => {}, scopeRooms: [r], myUserId: "@mod:example.tv",
    } as never));
  });
  let mounted = true;
  const cleanup = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  open.push(cleanup);
  return { calls, cleanup };
}

test("a site mod sees Timeout, even without power in this channel; the existing Ban stays", async () => {
  const { cleanup } = await render("@cleo:example.tv");
  assert.ok(button(/^Timeout$/));
  assert.ok(button(/^Ban$/));
  await cleanup();
  const noPower = await render("@cleo:example.tv", { viewerPower: 0 });
  assert.ok(button(/^Timeout$/), "a timeout is the site's, not the channel's");
  await noPower.cleanup();
});

test("not on your own card, not for a Discord member", async () => {
  // A viewer who is no mod: memberCardTimeoutNonMod.render.test.ts (useSiteMod keeps its first answer per page).
  for (const target of ["@mod:example.tv", "@discord_1:example.tv"]) {
    const { cleanup } = await render(target);
    assert.ok(button(/^Timeout$/) === null, target);
    await cleanup();
  }
});

test("pick a length, write a reason, confirm: one POST with userId, minutes and the reason", async () => {
  const { calls, cleanup } = await render("@cleo:example.tv");
  await act(async () => { button(/^Timeout$/)!.click(); });
  for (const label of ["1 minute", "10 minutes", "1 hour", "1 day", "1 week"]) assert.ok(button(new RegExp(`^${label}$`)), label);
  await act(async () => { button(/^1 hour$/)!.click(); });
  const confirm = button(/^Time out for 1 hour$/)!;
  assert.ok(confirm);
  assert.equal(confirm.disabled, true, "no reason yet: nothing can be sent");
  const reason = dom.window.document.querySelector('input[aria-label="Reason"]') as HTMLInputElement;
  await act(async () => { type(reason, "  spam  "); });
  assert.equal(button(/^Time out for 1 hour$/)!.disabled, false);
  await act(async () => { button(/^Time out for 1 hour$/)!.click(); });
  const posts = calls.filter((c) => c.url === "/api/mod/timeout");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.method, "POST");
  assert.deepEqual(posts[0]!.body, { userId: "@cleo:example.tv", minutes: 60, reason: "spam" });
  assert.match(dom.window.document.body.textContent ?? "", /Timed out until /);
  assert.doesNotMatch(dom.window.document.body.textContent ?? "", /—/, "no em-dash in the card's words");
  await cleanup();
});

test("a refusal shows the site's own words", async () => {
  const { cleanup } = await render("@cleo:example.tv", { timeout: { status: 409, body: { error: "That person is banned." } } });
  await act(async () => { button(/^Timeout$/)!.click(); });
  await act(async () => { type(dom.window.document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, "spam"); });
  await act(async () => { button(/^Time out for 10 minutes$/)!.click(); });
  assert.match(dom.window.document.body.textContent ?? "", /That person is banned\./);
  await cleanup();
});
