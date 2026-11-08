// The member card's Ban with "Delete message history" (client polish Task 21): the choice, the
// confirm sentence, the order of the steps, and the retry on a banned member's card.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/components/memberCardBanHistory.render.test.ts

import "../lib/testInstallValues.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act, resetStorage } from "../lib/testDom.ts";
import { installResizeObserverStub } from "../lib/testTsx.ts";

const ro = installResizeObserverStub();
const { MemberCard } = await import("@/app/components/MemberCard");
const { createRoot } = await import("react-dom/client");

const TARGET = "@cleo:example.tv";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

const CHECK = `/api/mod/ban-history?targetId=${encodeURIComponent("@cleo:example.tv")}`;
const REFUSED = "A moderator can't moderate Staff.";

/** `refuse`: the routes that answer 403 (the site's ceiling) — "ban", "check". */
function serve(calls: Call[], order: string[], banAnswer: Record<string, unknown> = { ok: true, purged: 2, batchId: "6f1c1f0e-8a8b-4c2e-9d3a-1b2c3d4e5f60" }, refuse: string[] = []) {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const method = init?.method ?? "GET";
    calls.push({ url: u, method, body });
    if (u.startsWith("/api/mod/")) order.push(u);
    const isCheck = u.startsWith("/api/mod/ban-history") && method === "GET";
    const isBan = u.startsWith("/api/mod/ban") && !u.startsWith("/api/mod/ban-history");
    if ((isCheck && refuse.includes("check")) || (isBan && refuse.includes("ban"))) {
      return Promise.resolve(new Response(REFUSED, { status: 403 }));
    }
    const answer = u.startsWith("/api/me") ? { signedIn: true, isMod: true }
      : u.startsWith("/api/presence") ? { counts: { onSite: 0, inCommunity: 0 }, users: {} }
      : u.startsWith("/api/mod/ban-history") ? { ok: true }
      : isBan ? banAnswer : {};
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } }));
  };
}

function fakeMember(userId: string, powerLevel: number, membership = "join") {
  return {
    userId, powerLevel, membership,
    name: userId.slice(1).split(":")[0], rawDisplayName: userId.slice(1).split(":")[0],
    getMxcAvatarUrl: () => null,
    events: { member: { getContent: () => ({}), getPrevContent: () => ({}) } },
  };
}

function lineOf(id: string, sender: string, ts: number) {
  return {
    getId: () => id, getSender: () => sender, getTs: () => ts, getType: () => "m.room.message",
    getWireType: () => "m.room.message", isState: () => false, isRedacted: () => false,
  };
}

function fakeRoom(order: string[], targetMembership = "join") {
  const now = Date.now();
  const events = [lineOf("$1", TARGET, now - 60_000), lineOf("$2", TARGET, now - 30_000), lineOf("$3", TARGET, now - 10_000), lineOf("$x", "@ok:example.tv", now)];
  const redacted: { id: string; reason?: string }[] = [];
  const room: Record<string, unknown> = {
    roomId: "!general:example.tv", name: "general",
    getDMInviter: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => events }),
    currentState: { hasSufficientPowerLevelFor: (_a: string, pl: number) => pl >= 50 },
    getMember: (id: string) => (id === TARGET ? fakeMember(id, 0, targetMembership) : id === "@mod:example.tv" ? fakeMember(id, 50) : null),
  };
  room.client = {
    getUser: () => null,
    getAccountData: () => undefined,
    getRoom: (id: string) => (id === room.roomId ? room : null),
    scrollback: async () => room,
    kick: async () => ({}),
    ban: async () => { order.push("matrix ban"); return {}; },
    unban: async () => ({}),
    redactEvent: async (_r: string, id: string, _t?: string, o?: { reason?: string }) => { order.push(`redact ${id}`); redacted.push({ id, reason: o?.reason }); return {}; },
  };
  return { room, redacted };
}

function buttonByText(re: RegExp): HTMLButtonElement | null {
  return ([...dom.window.document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => re.test(b.textContent ?? "")) ?? null;
}
const select = () => dom.window.document.querySelector("select[aria-label='Delete message history']") as HTMLSelectElement | null;
const siteSwitch = () => dom.window.document.querySelector("input[type=checkbox][data-site-purge]") as HTMLInputElement | null;
const sentence = () => dom.window.document.querySelector("[data-ban-confirm-text]")?.textContent ?? null;
const text = () => dom.window.document.body.textContent ?? "";

async function choose(value: string) {
  await act(async () => {
    const s = select()!;
    s.value = value;
    s.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
}

async function renderCard(room: Record<string, unknown>, membership = "join") {
  resetStorage();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MemberCard, {
      member: fakeMember(TARGET, 0, membership), room, x: 10, y: 10, side: "left", color: "#fff",
      canMessage: false, onMessage: () => {}, onClose: () => {}, scopeRooms: [room], myUserId: "@mod:example.tv",
    } as never));
  });
  return () => act(async () => { root.unmount(); host.remove(); });
}

test("Ban shows the three choices, default 'Don't delete any'", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room } = fakeRoom(order);
  const cleanup = await renderCard(room);
  assert.equal(select(), null, "the choice appears only once Ban is pressed");
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  const s = select();
  assert.ok(s, "Ban shows the choice");
  assert.deepEqual([...s!.options].map((o) => [o.value, o.textContent]), [
    ["none", "Don't delete any"], ["1h", "Previous hour"], ["7d", "Previous 7 days"],
  ]);
  assert.equal(s!.value, "none");
  // The site-chat switch of ticket #228 keeps its default: on.
  assert.equal(siteSwitch()?.checked, true);
  await cleanup();
});

test("the confirm reads the chosen text", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room } = fakeRoom(order);
  const cleanup = await renderCard(room);
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  assert.equal(sentence(), "Ban cleo and remove their site chat from the last 24 hours (at most 250 messages)? Their community messages stay. This can't be undone.");
  await choose("7d");
  assert.equal(sentence(), "Ban cleo and delete their messages from the last 7 days in every community channel, and from the last 24 hours in site chat (at most 250 messages)? This can't be undone.");
  await act(async () => { siteSwitch()!.click(); });
  await choose("none");
  assert.equal(sentence(), "Ban cleo? Their messages stay.");
  // The confirm button still names the reach.
  assert.ok(buttonByText(/Confirm ban from 1 channel, the site and platforms\?/));
  await cleanup();
});

test("Don't delete any: the ban as today, nothing redacted, no history route", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room, redacted } = fakeRoom(order);
  const cleanup = await renderCard(room);
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  await act(async () => { buttonByText(/Confirm ban/)!.click(); });
  assert.deepEqual(redacted, []);
  assert.deepEqual(order, ["matrix ban", "/api/mod/ban"]);
  const ban = calls.find((c) => c.url === "/api/mod/ban")!;
  assert.deepEqual(ban.body, { targetId: TARGET, purge: true });
  await cleanup();
});

test("Previous hour: the ban, then the redactions with a progress line, then ONE history call with both counts", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room, redacted } = fakeRoom(order);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client = room.client as { redactEvent: (...a: unknown[]) => Promise<unknown> };
  const real = client.redactEvent;
  let seen = 0;
  client.redactEvent = async (...a: unknown[]) => { if (seen++ === 1) await gate; return real(...a); };
  const cleanup = await renderCard(room);
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  await choose("1h");
  let done!: Promise<void>;
  await act(async () => { buttonByText(/Confirm ban/)!.click(); await new Promise((r) => setTimeout(r, 20)); done = Promise.resolve(); });
  assert.match(text(), /Removing messages… 1\/3/);
  await act(async () => { release(); await done; await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(order, ["matrix ban", "/api/mod/ban", CHECK, "redact $1", "redact $2", "redact $3", "/api/mod/ban-history"]);
  assert.deepEqual(redacted.map((r) => r.id), ["$1", "$2", "$3"]);
  const history = calls.find((c) => c.url === "/api/mod/ban-history")!;
  assert.deepEqual(history.body, { targetId: TARGET, window: "1h", communityRedacted: 3, communityFailed: 0, siteRemoved: 2, batchId: "6f1c1f0e-8a8b-4c2e-9d3a-1b2c3d4e5f60" });
  assert.match(text(), /Removed 3 community messages\./);
  assert.doesNotMatch(text(), /Removing messages…/);
  await cleanup();
});

test("retry: a banned member's card offers Delete message history (community only, no new ban)", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room, redacted } = fakeRoom(order, "ban");
  const cleanup = await renderCard(room, "ban");
  assert.ok(buttonByText(/^Unban$/));
  await act(async () => { buttonByText(/^Delete message history$/)!.click(); });
  // Here there is no "Don't delete any": the action IS the deletion.
  assert.deepEqual([...select()!.options].map((o) => o.value), ["1h", "7d"]);
  assert.equal(sentence(), "Delete cleo's messages from the last hour in every community channel? This can't be undone.");
  await act(async () => { buttonByText(/^Confirm delete$/)!.click(); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(order, [CHECK, "redact $1", "redact $2", "redact $3", "/api/mod/ban-history"]);
  assert.equal(redacted.length, 3);
  const history = calls.find((c) => c.url === "/api/mod/ban-history")!;
  assert.deepEqual(history.body, { targetId: TARGET, window: "1h", communityRedacted: 3, communityFailed: 0, siteRemoved: null, batchId: null });
  await cleanup();
});

test("a refused ban deletes nothing: a mod's Ban of a higher-ranked member, Previous 7 days (reviewer, round 1)", async () => {
  // A power-50 mod sees Ban on a Staff member's card (mayBan reads only the mod's own power). The
  // room bans fail, the site answers 403 — and Matrix would still accept every redaction from the
  // mod's client, so the card must not start one.
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order, undefined, ["ban", "check"]);
  const { room, redacted } = fakeRoom(order);
  (room.client as { ban: () => Promise<unknown> }).ban = async () => {
    order.push("matrix ban refused");
    throw Object.assign(new Error("no"), { errcode: "M_FORBIDDEN" });
  };
  const cleanup = await renderCard(room);
  await act(async () => { buttonByText(/^Ban$/)!.click(); });
  await choose("7d");
  await act(async () => { buttonByText(/Confirm ban/)!.click(); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(redacted, [], "not one line redacted");
  assert.deepEqual(order, ["matrix ban refused", "/api/mod/ban"], "no check, no redaction, no history row");
  assert.doesNotMatch(text(), /Removed \d+ community/);
  await cleanup();
});

test("a retry the ceiling refuses deletes nothing, and says why", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order, undefined, ["check"]);
  const { room, redacted } = fakeRoom(order, "ban");
  const cleanup = await renderCard(room, "ban");
  await act(async () => { buttonByText(/^Delete message history$/)!.click(); });
  await act(async () => { buttonByText(/^Confirm delete$/)!.click(); await new Promise((r) => setTimeout(r, 20)); });
  assert.deepEqual(redacted, []);
  assert.deepEqual(order, [CHECK], "the ceiling is asked before anything, and nothing follows its refusal");
  assert.match(text(), new RegExp(`Community messages weren't removed: ${REFUSED}`));
  await cleanup();
});

test("the card is placed wholly on screen: opened low on a phone, a tall card moves up (the Ban choices made it taller)", async () => {
  const calls: Call[] = []; const order: string[] = [];
  serve(calls, order);
  const { room } = fakeRoom(order);
  const win = dom.window as unknown as { innerHeight: number };
  const before = win.innerHeight;
  win.innerHeight = 844;
  const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
  const had = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get() { return (this as HTMLElement).classList.contains("glass") ? 520 : 0; } });
  resetStorage();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(MemberCard, {
        member: fakeMember(TARGET, 0), room, x: 10, y: 760, side: "right", color: "#fff",
        canMessage: false, onMessage: () => {}, onClose: () => {}, scopeRooms: [room], myUserId: "@mod:example.tv",
      } as never));
    });
    await act(async () => { ro.fire(); });
    const card = dom.window.document.querySelector(".glass") as HTMLElement;
    assert.equal(parseFloat(card.style.top), 844 - 520 - 8, "the card's bottom sits 8 px above the screen's");
    assert.match(card.style.maxHeight, /100dvh/, "a card taller than the screen scrolls inside itself");
  } finally {
    // Unmounted whatever happened: a failed assertion must end the run, not hang it.
    await act(async () => { root.unmount(); host.remove(); });
    if (had) Object.defineProperty(proto, "offsetHeight", had); else delete proto.offsetHeight;
    win.innerHeight = before;
  }
});
