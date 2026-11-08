// The DM window reads like a conversation (client polish Task 11; k's QoL item 1): its lines ARE
// the Community row (MatrixMessageRow) over the shared timeline engine (useRoomTimeline) — the
// picture beside grouped messages, a day divider, inline media, reactions, reply quotes, scroll-back
// without a yank — and the window's own rules on top: a "Replying to" strip whose send carries the
// reply, the menu a DM offers (React, Reply, Copy, Copy link, Delete on your own lines — never pin,
// vote or moderation), "Not sent" for a line that failed, and a read receipt only for an accepted
// conversation scrolled to its newest line.
//
// Mounted for real: DmWindow (and DmHost for the send path) on a fake client behind the page's
// Matrix handle. The conversation is DmWindow's lazy chunk (next/dynamic, so matrix-js-sdk stays
// out of the chat column's first load): each mount waits for it.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/dm/dmWindowRows.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dom, React, act, serveJson, resetStorage } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";
import { stripComments } from "../../lib/testSource.ts";

installResizeObserverStub();
// The auto-fill measures on the next frame: a frame here is the next macrotask.
const g = globalThis as unknown as { requestAnimationFrame: (cb: () => void) => unknown; cancelAnimationFrame: (h: unknown) => void };
g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
g.cancelAnimationFrame = (h) => clearTimeout(h as ReturnType<typeof setTimeout>);
// jsdom reports "prerender"; a person reading the window has the tab in front of them.
Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
const { default: DmWindow } = await import("./DmWindow.tsx");
const { default: DmHost } = await import("./DmHost.tsx");
const { setMatrixHandle } = await import("../../lib/matrixHandle.ts");
const { requestDm } = await import("../../lib/dm/bus.ts");
const { currentBinding, _resetComposerBindingForTests } = await import("../../lib/composerBinding.ts");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("../../lib/chrome/windowLayer.ts");
const { createRoot } = await import("react-dom/client");
// The row's menu (ContextMenu) reads the DOM's own element class.
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = dom.window.HTMLElement;

const ME = "@me:site.test";
const CASEY = "@casey:site.test";
const ROOM = "!dm:site.test";
const T0 = Date.UTC(2026, 9, 20, 15, 0, 0);
const DAY = 24 * 3600_000;
const casey = { matrixId: CASEY, username: "casey", displayName: "Casey" };

type Fake = Record<string, unknown> & { getId: () => string };
function ev(id: string, sender: string, ts: number, extra: { type?: string; content?: Record<string, unknown>; status?: string | null } = {}): Fake {
  const content = extra.content ?? { msgtype: "m.text", body: `line ${id}` };
  const type = extra.type ?? "m.room.message";
  const e: Fake = {
    getId: () => id, getSender: () => sender, getType: () => type, getTs: () => ts,
    isRedacted: () => false, isState: () => false, getContent: () => content, getOriginalContent: () => content,
    getWireContent: () => content, getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}),
    getThread: () => undefined, threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false,
    isDecryptionFailure: () => false, getRoomId: () => ROOM, getStateKey: () => undefined, status: extra.status ?? null,
  };
  return e;
}

/** A joined, private DM with casey, filed in m.direct, behind a ready client. */
function world(events: Fake[], opts: { sendFails?: boolean; echo?: boolean } = {}) {
  const roomEm = new EventEmitter();
  const clientEm = new EventEmitter();
  const sent: { roomId: string; type: string; content: Record<string, unknown>; txnId: string }[] = [];
  const receipts: unknown[][] = [];
  const scrollbacks: number[] = [];
  const member = (userId: string) => ({
    userId, membership: "join", name: userId.slice(1, userId.indexOf(":")), rawDisplayName: userId.slice(1, userId.indexOf(":")),
    getMxcAvatarUrl: () => null, roomId: ROOM,
    events: { member: { getTs: () => 0, getContent: () => ({ membership: "join", ...(userId === ME ? { is_direct: true } : {}) }) } },
  });
  const members = [member(ME), member(CASEY)];
  const room = {
    roomId: ROOM, name: "casey",
    getLiveTimeline: () => ({ getEvents: () => events, getPaginationToken: () => null }),
    getThreads: () => [],
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getMembers: () => members,
    getJoinedMembers: () => members,
    getJoinedMemberCount: () => 2,
    getInvitedMemberCount: () => 0,
    getJoinRule: () => "invite",
    getHistoryVisibility: () => "shared",
    getMyMembership: () => "join",
    getDMInviter: () => undefined,
    isSpaceRoom: () => false,
    getLastActiveTimestamp: () => T0,
    getUnreadNotificationCount: () => 0,
    getAccountData: () => undefined,
    getEventReadUpTo: () => null,
    hasEncryptionStateEvent: () => false,
    loadMembersIfNeeded: () => Promise.resolve(true),
    currentState: {
      getStateEvents: (...a: unknown[]) => (a.length > 1 ? null : []),
      // A DM's two members both hold power: the SDK would let me redact casey's lines too.
      maySendRedactionForEvent: () => true,
      maySendStateEvent: () => false,
      maySendEvent: () => true,
      getMember: () => null,
    },
    client: null as unknown,
    on: (n: string, f: (...a: unknown[]) => void) => { roomEm.on(n, f); },
    off: (n: string, f: (...a: unknown[]) => void) => { roomEm.off(n, f); },
    removeListener: (n: string, f: (...a: unknown[]) => void) => { roomEm.off(n, f); },
  };
  let txn = 0;
  const client = {
    getUserId: () => ME,
    getDeviceId: () => "DEV",
    getRoom: (id: string) => (id === ROOM ? room : null),
    getRooms: () => [room],
    getAccountData: (t: string) => (t === "m.direct" ? { getContent: () => ({ [CASEY]: [ROOM] }) } : undefined),
    getCrypto: () => null,
    getUser: () => null,
    mxcUrlToHttp: () => null,
    getHomeserverUrl: () => "https://matrix.site.test",
    fetchRoomEvent: () => new Promise(() => {}),
    decryptEventIfNeeded: () => Promise.resolve(),
    makeTxnId: () => `t${++txn}`,
    sendEvent: async (roomId: string, _thread: unknown, type: string, content: Record<string, unknown>, txnId: string) => {
      sent.push({ roomId, type, content, txnId });
      if (opts.sendFails) {
        // As the SDK: the echo stays in the timeline as NOT_SENT, and the send rejects.
        events.push(ev(`~${ROOM}:${txnId}`, ME, T0 + 99_000, { content, status: "not_sent" }));
        roomEm.emit("Room.localEchoUpdated");
        throw new Error("offline");
      }
      if (opts.echo) {
        // As the SDK: the echo is in the timeline (still sending) the moment the send starts.
        events.push(ev(`~${ROOM}:${txnId}`, ME, T0 + 99_000, { content, status: "sending" }));
        roomEm.emit("Room.localEchoUpdated");
      }
      return { event_id: "$sent" };
    },
    scrollback: async (_r: unknown, n: number) => { scrollbacks.push(n); },
    sendReadReceipt: async (...a: unknown[]) => { receipts.push(["sendReadReceipt", ...a]); },
    setRoomReadMarkers: async (...a: unknown[]) => { receipts.push(["setRoomReadMarkers", ...a]); },
    on: (n: string, f: (...a: unknown[]) => void) => clientEm.on(n, f),
    off: (n: string, f: (...a: unknown[]) => void) => clientEm.off(n, f),
    removeListener: (n: string, f: (...a: unknown[]) => void) => clientEm.off(n, f),
  };
  room.client = client;
  setMatrixHandle({ client: client as never, status: "ready", startClient: async () => {} });
  return { room, client, roomEm, sent, receipts, scrollbacks, done: () => setMatrixHandle({ client: null, status: "idle", startClient: async () => {} }) };
}

/** Let the lazy conversation chunk, the first refresh and the debounced effects land. */
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function mount(el: React.ReactElement) {
  // A test that failed mid-way left its window behind: start from an empty page.
  dom.window.document.body.replaceChildren();
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  await settle();
  await settle();
  const q = (s: string) => dom.window.document.querySelector(s) as HTMLElement | null;
  const all = (s: string) => [...dom.window.document.querySelectorAll(s)] as HTMLElement[];
  return { q, all, unmount: async () => { await act(async () => { root.unmount(); }); layer.remove(); host.remove(); } };
}

type Convo = Parameters<typeof DmWindow>[0]["convo"];
type Cb = Partial<{ retry: (id: string) => void; drop: (id: string) => void; reply: (r: unknown) => void; cancelReply: () => void }>;
function win(convo: Partial<Convo>, cb: Cb = {}) {
  const noop = () => {};
  return React.createElement(DmWindow, {
    convo: { seq: 1, person: casey, phase: "open", incoming: false, accepted: true, roomId: ROOM, encrypted: true, caution: null, ...convo } as Convo,
    closeRef: { current: null },
    onAccept: noop, onDecline: noop, onRequest: noop, onStartPrivate: noop, onBlock: noop, onPick: noop, onClose: noop,
    onRetry: cb.retry ?? noop, onDrop: cb.drop ?? noop,
    onReply: cb.reply ?? noop, onCancelReply: cb.cancelReply ?? noop,
  });
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const rowOf = (m: { q: (s: string) => HTMLElement | null }, id: string) => m.q(`[data-dm-window] [data-event-id="${id}"]`);

test("the conversation is the Community row: a head with its picture, then a grouped line, in a narrow pane", async () => {
  const w = world([ev("$1", CASEY, T0), ev("$2", CASEY, T0 + 60_000), ev("$3", ME, T0 + 120_000)]);
  const m = await mount(win({}));
  const list = m.q("[data-dm-window] [data-mx-pane='narrow']");
  assert.ok(list, "the conversation's root is a narrow pane (the 32px picture, the short time)");
  assert.ok(rowOf(m, "$1")?.hasAttribute("data-head"), "casey's first line is a head");
  assert.ok(rowOf(m, "$1")!.querySelector(".mx-avatar"), "with the picture");
  assert.equal(rowOf(m, "$2")!.hasAttribute("data-head"), false, "her next line within five minutes is grouped");
  assert.ok(rowOf(m, "$3")?.hasAttribute("data-head"), "my line is a new head");
  assert.ok(m.q("[data-dm-window] ol") === null, "the old plain list is gone");
  await m.unmount();
  w.done();
});

test("image renders the attachment", async () => {
  const w = world([ev("$img", CASEY, T0, { content: { msgtype: "m.image", body: "cat.png", url: "mxc://site.test/cat", info: { w: 400, h: 300, mimetype: "image/png" } } })]);
  const m = await mount(win({}));
  const img = rowOf(m, "$img")?.querySelector("img[alt='cat.png']");
  assert.ok(img, "the picture shows in the line, not its file name");
  await m.unmount();
  w.done();
});

test("reaction pile shows", async () => {
  const w = world([
    ev("$1", CASEY, T0),
    ev("$r", ME, T0 + 1000, { type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" } } }),
  ]);
  const m = await mount(win({}));
  const pile = [...(rowOf(m, "$1")?.querySelectorAll("button[data-reaction-key][aria-pressed='true']") ?? [])];
  assert.equal(pile.length, 1, "my reaction is a pile on her line");
  assert.match(pile[0]!.textContent ?? "", /1/);
  assert.ok(rowOf(m, "$r") === null, "the reaction is not a line of its own");
  await m.unmount();
  w.done();
});

test("sheet lists React/Reply/Copy/Delete-own/Copy link only", async () => {
  const w = world([ev("$theirs", CASEY, T0), ev("$mine", ME, T0 + DAY)]);
  const m = await mount(win({}));
  const items = async (id: string) => {
    const more = rowOf(m, id)!.querySelector("button[title='More']")!;
    await click(more);
    const menu = m.q("[role='menu']")!;
    const labels = [...menu.querySelectorAll("[role='menuitem']")].map((b) => (b.textContent ?? "").trim()); // the icon is an svg: no text of its own
    // Tab closes the menu (the ARIA menu pattern, ContextMenu.tsx).
    await act(async () => { menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
    assert.ok(m.q("[role='menu']") === null, "the menu closed");
    return labels;
  };
  assert.deepEqual(await items("$mine"), ["React", "Reply", "Copy text", "Copy link", "Delete"]);
  assert.deepEqual(await items("$theirs"), ["React", "Reply", "Copy text", "Copy link"], "never Delete on their line, though the room's power would allow it");
  await m.unmount();
  w.done();
});

test("two days → one divider", async () => {
  const w = world([ev("$1", CASEY, T0), ev("$2", CASEY, T0 + 60_000), ev("$3", ME, T0 + DAY)]);
  const m = await mount(win({}));
  const dividers = m.all("[data-dm-window] [role='separator']");
  assert.equal(dividers.length, 2, "one above each day's first line");
  const seq = m.all("[data-dm-window] [role='separator'], [data-dm-window] [data-event-id]").map((n) => n.getAttribute("data-event-id") ?? "day");
  assert.deepEqual(seq, ["day", "$1", "$2", "day", "$3"], "one divider between the two days");
  await m.unmount();
  w.done();
});

test("scrolled up + new line → scrollTop unchanged, pill shown", async () => {
  const events = [ev("$1", CASEY, T0), ev("$2", CASEY, T0 + 1000)];
  const w = world(events);
  const box = { scrollTop: 0 };
  const proto = dom.window.HTMLElement.prototype;
  const desc = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight") ?? Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight") ?? Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 400 });
  try {
    const m = await mount(win({}));
    const scroller = m.q("[data-dm-window] [role='log']")!;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => box.scrollTop, set: (v: number) => { box.scrollTop = v; } });
    // The person wheels up to read: the engine pauses.
    await act(async () => { scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -300 })); });
    box.scrollTop = 900;
    await act(async () => { scroller.dispatchEvent(new dom.window.Event("scroll")); });
    events.push(ev("$3", CASEY, T0 + 2000));
    await act(async () => { w.roomEm.emit("Room.timeline"); });
    await settle();
    assert.equal(box.scrollTop, 900, "no yank: the reading position holds");
    assert.ok(rowOf(m, "$3") === null, "the new line waits past the pause");
    const pill = [...m.all("[data-dm-window] button")].find((b) => /1 new message/.test(b.textContent ?? ""));
    assert.ok(pill, "the pill says a line is waiting");
    await click(pill!);
    await settle();
    assert.ok(rowOf(m, "$3"), "the pill brings it in");
    await m.unmount();
  } finally {
    for (const [k, d] of Object.entries(desc)) {
      if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k];
    }
    w.done();
  }
});

test("sized panel → list not capped", async () => {
  const w = world([ev("$1", CASEY, T0)]);
  const m = await mount(win({}));
  const body = m.q("[data-dm-window]")!;
  assert.ok(body.hasAttribute("data-scroll-inner"), "the window body is a frame: the list inside it scrolls");
  const scroller = m.q("[data-dm-window] [role='log']")!;
  assert.match(scroller.className, /(^|\s)flex-1(\s|$)/);
  assert.match(scroller.className, /(^|\s)min-h-0(\s|$)/);
  for (let n: HTMLElement | null = scroller; n && n !== body; n = n.parentElement) {
    assert.doesNotMatch(n.className, /max-h-/, "no fixed cap between the list and the window: a taller panel shows more lines");
  }
  await m.unmount();
  w.done();
});

test("an open conversation shows its lines from the room — my name and theirs on the Community row, and an unreadable line said plainly", async () => {
  const broken = ev("$3", CASEY, T0 + 2000, { content: {} });
  broken.isDecryptionFailure = () => true;
  broken.decryptionFailureReason = "MEGOLM_UNKNOWN_INBOUND_SESSION_ID";
  const events = [ev("$1", ME, T0, { content: { msgtype: "m.text", body: "hi casey" } }), ev("$2", CASEY, T0 + 1000, { content: { msgtype: "m.text", body: "hey!" } }), broken];
  const w = world(events);
  const m = await mount(win({}));
  assert.match(rowOf(m, "$1")!.textContent ?? "", /me.*hi casey/);
  assert.match(rowOf(m, "$2")!.textContent ?? "", /casey.*hey!/);
  assert.match(rowOf(m, "$3")!.textContent ?? "", /Waiting for this message's key…/, "a line whose key has not come yet says it is waiting (keyWait.ts)");
  events.push(ev("$4", CASEY, T0 + 3000, { content: { msgtype: "m.text", body: "new one" } }));
  await act(async () => { w.roomEm.emit("Room.timeline"); });
  await settle();
  assert.match(rowOf(m, "$4")?.textContent ?? "", /new one/, "a new line follows");
  await m.unmount();
  w.done();
});

test("failed line shows Not sent; Retry calls retryLine(id)", async () => {
  const w = world([ev("$1", ME, T0), ev(`~${ROOM}:t9`, ME, T0 + 1000, { status: "not_sent" })]);
  const retried: string[] = [];
  const dropped: string[] = [];
  const m = await mount(win({}, { retry: (id) => retried.push(id), drop: (id) => dropped.push(id) }));
  assert.ok(rowOf(m, "$1")!.querySelector("[role='status']") === null, "a sent line carries no mark");
  const status = rowOf(m, `~${ROOM}:t9`)!.querySelector("[role='status']")!;
  assert.match(status.textContent ?? "", /Not sent.*Retry.*Delete/);
  await click([...status.querySelectorAll("button")].find((b) => b.textContent === "Retry")!);
  await click([...status.querySelectorAll("button")].find((b) => b.textContent === "Delete")!);
  assert.deepEqual(retried, [`~${ROOM}:t9`]);
  assert.deepEqual(dropped, [`~${ROOM}:t9`]);
  await m.unmount();
  w.done();
});

test("replyTo: a reply shows the quote of the line it answers, with its sender, and no raw fallback", async () => {
  const w = world([
    ev("$orig", ME, T0, { content: { msgtype: "m.text", body: "hi" } }),
    ev("$2", CASEY, T0 + 1000, { content: { msgtype: "m.text", body: "> <@me:site.test> hi\n\nhey you", "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } } } }),
  ]);
  const m = await mount(win({}));
  const row = rowOf(m, "$2")!;
  const jump = row.querySelector("button[aria-label='Jump to the original message']");
  assert.ok(jump, "the quote is a button: the DM passes its jump (onJumpToReply)");
  assert.match(row.textContent ?? "", /me.*hi/, "the quote names whom it answers");
  assert.match(row.textContent ?? "", /hey you/);
  assert.doesNotMatch(row.querySelector(".mx-text:last-child")?.textContent ?? "", /^>/, "no raw quote");
  await m.unmount();
  w.done();
});

test("a line still sending is faint and says nothing", async () => {
  const w = world([ev(`~${ROOM}:t1`, ME, T0, { status: "sending" })]);
  const m = await mount(win({}));
  const row = rowOf(m, `~${ROOM}:t1`)!;
  const faint = row.querySelector("[data-echo='sending']");
  assert.ok(faint && faint.className.includes("opacity-60"), "faint while on its way");
  assert.ok(row.querySelector("[role='status']") === null, "no Not sent");
  await m.unmount();
  w.done();
});

test("a reply whose original is not here and cannot be fetched says the original isn't available", async () => {
  const w = world([ev("$4", ME, T0, { content: { msgtype: "m.text", body: "sure", "m.relates_to": { "m.in_reply_to": { event_id: "$x" } } } })]);
  w.client.fetchRoomEvent = () => Promise.reject(Object.assign(new Error("not found"), { errcode: "M_NOT_FOUND", httpStatus: 404 }));
  const m = await mount(win({}));
  await settle();
  assert.match(rowOf(m, "$4")!.textContent ?? "", /Original message isn't available/, "never a name it cannot know");
  await m.unmount();
  w.done();
});

test("accepted + atBottom → sendReadMarker(newest)", async () => {
  const w = world([ev("$8", CASEY, T0), ev("$9", CASEY, T0 + 1000)]);
  const m = await mount(win({ accepted: true }));
  await settle(900); // useReadReceipts debounces 800 ms
  assert.equal(w.receipts.length, 1, "one receipt");
  assert.equal(w.receipts[0]![0], "setRoomReadMarkers");
  assert.equal(w.receipts[0]![1], ROOM);
  assert.equal(w.receipts[0]![2], "$9", "on the newest line");
  await m.unmount();
  w.done();
});

test("unaccepted → none", async () => {
  const w = world([ev("$9", CASEY, T0)]);
  const m = await mount(win({ incoming: true, accepted: false }));
  await settle(900);
  assert.deepEqual(w.receipts, []);
  // A request not yet answered offers no reply or reaction either: there is no box to answer in.
  assert.ok(rowOf(m, "$9")!.querySelector("button[title='Reply']") === null);
  await m.unmount();
  w.done();
});

test("the Reply strip names whom the next line answers, and ✕ lets it go", async () => {
  let cancelled = 0;
  const w = world([ev("$1", CASEY, T0)]);
  const m = await mount(win({ replyTo: { eventId: "$1", roomId: ROOM, senderUserId: CASEY, senderLabel: "casey", body: "line $1" } }, { cancelReply: () => { cancelled += 1; } }));
  const strip = m.q("[data-dm-reply]")!;
  assert.match(strip.textContent ?? "", /Replying to casey/);
  await click(strip.querySelector("button[aria-label='Cancel reply']")!);
  assert.equal(cancelled, 1);
  await m.unmount();
  w.done();
});

// ── the send path, through the real host ────────────────────────────────────────────────────

async function openHost() {
  resetStorage();
  serveJson({ banned: false });
  _resetComposerBindingForTests();
  const m = await mount(React.createElement(DmHost));
  await act(async () => { requestDm({ kind: "open", to: casey }); });
  await settle();
  await settle();
  return m;
}

test("Reply strip → send carries m.in_reply_to", async () => {
  const w = world([ev("$1", CASEY, T0, { content: { msgtype: "m.text", body: "are you live?" } })]);
  const m = await openHost();
  try {
    const reply = rowOf(m, "$1")!.querySelector("button[title='Reply']")!;
    await click(reply);
    assert.match(m.q("[data-dm-reply]")?.textContent ?? "", /Replying to casey/, "the strip shows");
    const binding = currentBinding();
    assert.ok(binding && binding.kind === "sendTo", "the chat box is bound to the conversation");
    await act(async () => { await binding!.send("yes, now"); });
    assert.equal(w.sent.length, 1);
    const c = w.sent[0]!.content;
    assert.equal(w.sent[0]!.type, "m.room.message");
    assert.deepEqual(c["m.relates_to"], { "m.in_reply_to": { event_id: "$1" } });
    assert.match(String(c.body), /^> <@casey:site\.test> are you live\?\n\nyes, now$/);
    assert.ok(m.q("[data-dm-reply]") === null, "the strip goes once the line is in the conversation");
    // The next line is a plain line again.
    await act(async () => { await currentBinding()!.send("second"); });
    assert.equal(w.sent[1]!.content["m.relates_to"], undefined);
  } finally {
    await m.unmount();
    w.done();
  }
});

test("failed echo → box clears, row Not sent", async () => {
  const w = world([ev("$1", CASEY, T0)], { sendFails: true });
  const m = await openHost();
  try {
    const errs = console.error;
    console.error = () => {};
    let threw = false;
    try {
      await act(async () => { await currentBinding()!.send("probe").catch(() => { threw = true; }); });
    } finally { console.error = errs; }
    await settle();
    assert.equal(threw, false, "the send resolves — the chat box clears; the line holds the text");
    const row = m.all("[data-dm-window] [data-event-id]").find((r) => r.getAttribute("data-event-id")!.startsWith("~"));
    assert.ok(row, "the failed line is in the conversation");
    assert.match(row!.textContent ?? "", /probe/);
    assert.match(row!.querySelector("[role='status']")?.textContent ?? "", /Not sent.*Retry/);
  } finally {
    await m.unmount();
    w.done();
  }
});

test("scrolled up + own send → at the bottom, no pill — sent, and Not sent (its Retry is never hidden)", async () => {
  const proto = dom.window.HTMLElement.prototype;
  const desc = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight") ?? Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight") ?? Object.getOwnPropertyDescriptor(dom.window.Element.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 400 });
  try {
    for (const mode of ["sent", "not sent"] as const) {
      const w = world([ev("$1", CASEY, T0), ev("$2", CASEY, T0 + 1000)], mode === "sent" ? { echo: true } : { sendFails: true });
      const m = await openHost();
      try {
        const scroller = m.q("[data-dm-window] [role='log']")!;
        const box = { scrollTop: 0 };
        Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => box.scrollTop, set: (v: number) => { box.scrollTop = v; } });
        // The person wheels up to an older line: the list pauses.
        await act(async () => { scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -300 })); });
        box.scrollTop = 600;
        await act(async () => { scroller.dispatchEvent(new dom.window.Event("scroll")); });
        const pill = () => m.all("[data-dm-window] button").find((b) => /Chat paused|new message/.test(b.textContent ?? ""));
        assert.ok(pill(), `${mode}: paused while reading`);
        const errs = console.error;
        console.error = () => {};
        try {
          await act(async () => { await currentBinding()!.send(`mine ${mode}`); });
        } finally { console.error = errs; }
        await settle();
        assert.ok(pill() === undefined, `${mode}: no pill — the list followed the person's own line`);
        assert.equal(box.scrollTop, 2000, `${mode}: at the bottom`);
        const row = m.all("[data-dm-window] [data-event-id]").find((r) => r.textContent?.includes(`mine ${mode}`));
        assert.ok(row, `${mode}: the line is a row on screen, not queued behind the pill`);
        if (mode === "not sent") assert.match(row!.querySelector("[role='status']")?.textContent ?? "", /Not sent.*Retry/);
      } finally {
        await m.unmount();
        w.done();
      }
    }
  } finally {
    for (const [k, d] of Object.entries(desc)) {
      if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k];
    }
  }
});

test("the DM window offers no pin, vote or moderation on its rows", () => {
  const src = stripComments(readFileSync(new URL("./DmConversation.tsx", import.meta.url), "utf8"));
  assert.match(src, /<MatrixMessageRow\b/, "the rows are the Community row");
  assert.match(src, /onJumpToReply=\{jumpToEvent\}/);
  assert.doesNotMatch(src, /onTogglePin|onVote|moderationScope/);
  const win = stripComments(readFileSync(new URL("./DmWindow.tsx", import.meta.url), "utf8"));
  assert.doesNotMatch(win, /onTogglePin|onVote|moderationScope/);
  assert.match(win, /\}\s*$/, "vacuity anchor: DmWindow.tsx was read to the end");
  assert.match(src, /\}\s*$/, "vacuity anchor: DmConversation.tsx was read to the end");
});
