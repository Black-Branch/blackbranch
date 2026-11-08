// The DM list as a person sees it (client polish Task 20; k's items 2, 3, 9, 11): the REAL
// ChannelColumn, SpacesRail and EarlierConversation over the three-rooms fixture — one row per
// person with the last line and how long ago, a rail chip per unread conversation, the row's own
// menu (Pin · Close · Leave, Leave behind a confirm), and "Earlier conversation" opening the older
// room. The client reaches ChannelColumn through useMatrixClient(); that one hook is swapped for the
// fixture's client by resolving the context module to a shim that re-exports the real one.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/community/dmList.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
import { ME, SAM, T, THEM, threeRooms } from "../../lib/fixtures/dmThreeRooms.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM = "data:text/javascript," + encodeURIComponent(
  `export * from ${JSON.stringify(REAL_CTX)};\nexport function useMatrixClient() { return globalThis.__dmListCtx; }\n`,
);
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});

const { ChannelColumn } = await import("./ChannelColumn.tsx");
const { SpacesRail } = await import("./SpacesRail.tsx");
const { EarlierConversation } = await import("./EarlierConversation.tsx");
const { dmConversations } = await import("../../lib/dmConversations.ts");
const { createRoot } = await import("react-dom/client");

type Scene = ReturnType<typeof threeRooms>;
type C = Parameters<typeof dmConversations>[0];
const noop = () => {};
const asyncNoop = async () => {};

function setCtx(s: Scene) {
  (globalThis as unknown as { __dmListCtx: unknown }).__dmListCtx = {
    client: Object.assign(s.client, { pushRules: undefined }), status: "ready", startClient: asyncNoop, retry: noop, matrixId: ME, identityKnown: true,
  };
}

async function mount(el: React.ReactElement) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    host,
    all: (sel: string) => [...dom.window.document.querySelectorAll(sel)] as HTMLElement[],
    q: (sel: string) => dom.window.document.querySelector(sel) as HTMLElement | null,
    rerender: (next: React.ReactElement) => act(async () => { root.render(next); }),
    unmount: () => act(async () => { root.unmount(); host.remove(); }),
  };
}

const column = (s: Scene, extra: Record<string, unknown> = {}) => React.createElement(ChannelColumn as never, {
  mode: "home", server: null, conversations: dmConversations(s.client as unknown as C, ME, {}),
  onOpenConversation: noop, pinned: [], invites: [s.request], selected: null, myUserId: ME,
  onSelect: noop, onAcceptInvite: asyncNoop, onRejectInvite: asyncNoop, serverRooms: [], ...extra,
});

const rail = (s: Scene, onOpen: (c: unknown) => void) => React.createElement(SpacesRail as never, {
  servers: [], activeId: "home", homeUnreads: { total: 0, highlight: 0 }, canAddSpace: false,
  onSelectHome: noop, onSelectServer: noop, onAddSpace: noop, rooms: s.rooms, myUserId: ME,
  onOpenRoomThreads: noop, onOpenSettings: noop, hideUserButton: true,
  conversations: dmConversations(s.client as unknown as C, ME, {}), onOpenConversation: onOpen,
});

const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const rightClick = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("one row per person with preview and relative time", async () => {
  resetStorage();
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  const rows = m.all("[data-dm-row]");
  assert.deepEqual(rows.map((r) => r.getAttribute("data-dm-row")), [THEM, SAM], "Robin once (three rooms), then Sam; nobody for the empty room");
  const robin = rows[0]!;
  assert.match(robin.textContent ?? "", /Robin/);
  assert.equal(robin.querySelector("[data-dm-preview]")!.textContent, "You: line 17", "the newest room's last line");
  assert.match(robin.querySelector("[data-dm-when]")!.textContent ?? "", /ago$/, "how long ago");
  // The request is answered in Invites, not listed as a conversation.
  assert.match(m.host.textContent ?? "", /Invites/);
  assert.match(m.host.textContent ?? "", /wants to message you/);
  await m.unmount();
});

// #236: the DM list's pictures were Avatar size 32 "at a 14px font" — 49px drawn, × the Chat rows
// Avatar-size slider on top (69px at 1.4×). A list row now takes the scale's md step (Discord's
// 32px DM list) and ignores the slider, which belongs to chat rows; invites and chips likewise.
test("the DM list's pictures take the scale's list step, never the chat rows' Avatar-size slider", async () => {
  resetStorage();
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  try {
    const rows = m.all("[data-dm-row]");
    assert.ok(rows.length >= 2, "the fixture's two people are listed");
    for (const row of rows) {
      const pic = row.querySelector(".avatar") as HTMLElement | null;
      assert.ok(pic, `${row.getAttribute("data-dm-row")}: the row's picture wears the scale's class`);
      assert.equal(pic!.style.getPropertyValue("--avatar-size"), "var(--avatar-md)");
      assert.doesNotMatch(pic!.getAttribute("style") ?? "", /chat-pfp-scale|\d(px|rem)/);
    }
    // The invite row (the person who wants to message you) is a list row too.
    const invitePic = [...m.host.querySelectorAll(".avatar")].find((p) => !p.closest("[data-dm-row]")) as HTMLElement | undefined;
    assert.ok(invitePic, "the invite row has its picture");
    assert.equal(invitePic!.style.getPropertyValue("--avatar-size"), "var(--avatar-md)");
  } finally { await m.unmount(); }
});

test("the rail's DM chips take the scale's lg step (the rail's tile), not a size of their own", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(rail(s, noop));
  try {
    const chip = m.all("[data-dm-chip]")[0];
    assert.ok(chip, "an unread conversation has a chip");
    assert.equal((chip!.querySelector(".avatar") as HTMLElement | null)?.style.getPropertyValue("--avatar-size"), "var(--avatar-lg)");
    assert.doesNotMatch(chip!.getAttribute("style") ?? "", /--dm-chip/, "no private chip size");
  } finally { await m.unmount(); }
});

test("tapping a row opens the person's ACTIVE room", async () => {
  const s = threeRooms();
  setCtx(s);
  const opened: string[] = [];
  const m = await mount(column(s, { onOpenConversation: (c: { active: { roomId: string } }) => opened.push(c.active.roomId) }));
  await click(m.all("[data-dm-row]")[0]!);
  assert.deepEqual(opened, ["!z"]);
  await m.unmount();
});

test("an earlier room open in the timeline still lights its person's row", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s, { selected: s.x }));
  assert.match(m.all("[data-dm-row]")[0]!.className, /bg-surface-2/);
  await m.unmount();
});

test("rail shows one chip per unread conversation, newest first", async () => {
  const s = threeRooms();
  (s.sam as unknown as { getUnreadNotificationCount: (t?: string) => number }).getUnreadNotificationCount = (t) => (t === "highlight" ? 0 : 1);
  setCtx(s);
  const opened: string[] = [];
  const m = await mount(rail(s, (c) => opened.push((c as { partner: string }).partner)));
  const chips = m.all("[data-dm-chip]");
  assert.deepEqual(chips.map((c) => c.getAttribute("data-dm-chip")), [THEM, SAM], "Robin's line is newer than Sam's");
  assert.equal(chips[0]!.textContent?.trim().endsWith("2"), true, "the count");
  await click(chips[1]!);
  assert.deepEqual(opened, [SAM], "a tap opens that conversation");
  await m.unmount();
});

test("chip gone after the read receipt", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(rail(s, noop));
  assert.equal(m.all("[data-dm-chip]").length, 1, "Robin has 2 unread");
  // The receipt for the newest line is sent: the server's count for the room drops to 0.
  (s.z as unknown as { getUnreadNotificationCount: () => number }).getUnreadNotificationCount = () => 0;
  await m.rerender(rail(s, noop));
  assert.equal(m.all("[data-dm-chip]").length, 0);
  assert.equal(m.q("[data-dm-rail-chips]"), null, "no empty block above the spaces");
  await m.unmount();
});

test("long-press offers Pin, Close, Leave", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  await rightClick(m.all("[data-dm-row]")[0]!);
  const menu = m.q("[data-dm-actions]");
  assert.ok(menu, "the row's menu opened");
  const items = [...menu!.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);
  assert.deepEqual(items, ["Pin conversation", "Close conversationHidden until they write again.", "Leave conversation"]);
  await click([...menu!.querySelectorAll("[role=menuitem]")][0]!);
  await settle();
  assert.deepEqual(s.client.calls, ["setRoomTag !z m.favourite"], "Pin goes on the room they write in");
  assert.equal(m.q("[data-dm-actions]"), null, "done: the menu closes");
  await m.unmount();
});

test("a context menu with no point (a keyboard's menu key) still opens the menu on screen, under the row", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  await act(async () => { m.all("[data-dm-row]")[0]!.dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true })); });
  const menu = m.q("[data-dm-actions]")!;
  assert.match(menu.style.top, /^\d+(\.\d+)?px$/, "a real position, not NaN (which left the menu below the screen)");
  assert.match(menu.style.left, /^\d+(\.\d+)?px$/);
  await m.unmount();
});

test("Close writes the close to account data and the row is gone from the list it feeds (the next line bringing it back: dmConversations.test.ts)", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  await rightClick(m.all("[data-dm-row]")[0]!);
  const close = [...m.q("[data-dm-actions]")!.querySelectorAll("[role=menuitem]")][1]!;
  await click(close);
  await settle();
  assert.ok(s.client.calls[0]!.startsWith("setAccountData app.blackbranch.dm_closed"));
  const { readClosed } = await import("../../lib/dmConversations.ts");
  const closed = readClosed(s.client as unknown as C);
  const visible = (await import("../../lib/dmConversations.ts")).dmConversations(s.client as unknown as C, ME, closed);
  await m.rerender(column(s, { conversations: visible }));
  assert.deepEqual(m.all("[data-dm-row]").map((r) => r.getAttribute("data-dm-row")), [SAM]);
  await m.unmount();
});

test("Leave asks to confirm and leaves every room", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  await rightClick(m.all("[data-dm-row]")[0]!);
  const leave = [...m.q("[data-dm-actions]")!.querySelectorAll("[role=menuitem]")][2]!;
  await click(leave);
  assert.deepEqual(s.client.calls, [], "nothing left yet: it asks first");
  const confirm = m.q("[data-dm-leave-confirm]")!;
  assert.match(confirm.textContent ?? "", /Leave your conversation with Robin\? They will see that you left\./);
  await click([...confirm.querySelectorAll("button")].find((b) => b.textContent === "Leave")!);
  await settle();
  assert.deepEqual(s.client.calls, ["leave !z", "leave !y", "leave !x"]);
  await m.unmount();
});

test("Leave's Cancel leaves nothing", async () => {
  const s = threeRooms();
  setCtx(s);
  const m = await mount(column(s));
  await rightClick(m.all("[data-dm-row]")[0]!);
  await click([...m.q("[data-dm-actions]")!.querySelectorAll("[role=menuitem]")][2]!);
  await click([...m.q("[data-dm-leave-confirm]")!.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!);
  assert.deepEqual(s.client.calls, []);
  assert.ok(m.q("[data-dm-actions] [role=menuitem]"), "back to the menu");
  await m.unmount();
});

test("retry: a Leave that fails keeps the menu open, says so, and a second press tries again", async () => {
  const s = threeRooms();
  let fail = true;
  const leave = s.client.leave;
  s.client.leave = async (id: string) => { if (fail) throw new Error("offline"); return leave(id); };
  setCtx(s);
  const m = await mount(column(s));
  const origWarn = console.warn;
  console.warn = noop;
  try {
    await rightClick(m.all("[data-dm-row]")[0]!);
    await click([...m.q("[data-dm-actions]")!.querySelectorAll("[role=menuitem]")][2]!);
    const press = () => click([...m.q("[data-dm-leave-confirm]")!.querySelectorAll("button")].find((b) => b.textContent === "Leave")!);
    await press();
    await settle();
    assert.match(m.q("[data-dm-actions] [role=alert]")?.textContent ?? "", /Couldn.t do that\. Try again\./);
    fail = false;
    await press();
    await settle();
    assert.deepEqual(s.client.calls, ["leave !z", "leave !y", "leave !x"]);
  } finally {
    console.warn = origWarn;
  }
  await m.unmount();
});

test("EarlierConversation lists N messages and opens read-only", async () => {
  const s = threeRooms();
  const opened: string[] = [];
  const m = await mount(React.createElement(EarlierConversation, { rooms: [s.y, s.x] as never, onOpen: (r: { roomId: string }) => opened.push(r.roomId) }));
  const bar = m.q("[data-earlier-conversation]")!;
  const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  assert.equal(bar.textContent, `Earlier conversation · 2 messages · ${day(T + 1000)} – ${day(T + 86_400_000 + 120_000)}`);
  await click(bar);
  assert.deepEqual(opened, ["!y"], "the newest of the earlier rooms");
  await m.unmount();
});
