// The DM window's frame (client polish Task 12; k's QoL item 1), mounted for real through DmHost on
// a fake client behind the page's Matrix handle: the header shows the person's picture and presence
// dot and the name opens their card; "casey is typing…" shows in the window and our typing goes out
// from the bound chat box; a second conversation waiting behind shows as "+1 · sam" and a tap
// switches to it (the line typed for the first one goes with it); "Open in Community" hands the room
// to the Matrix tab.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/dm/dmWindowFrame.render.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import { installResizeObserverStub } from "../../lib/testTsx.ts";
import { stripComments } from "../../lib/testSource.ts";

installResizeObserverStub();
const g = globalThis as unknown as { requestAnimationFrame: (cb: () => void) => unknown; cancelAnimationFrame: (h: unknown) => void };
g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
g.cancelAnimationFrame = (h) => clearTimeout(h as ReturnType<typeof setTimeout>);
Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
const { default: DmHost } = await import("./DmHost.tsx");
const { setMatrixHandle } = await import("../../lib/matrixHandle.ts");
const { requestDm, takeOpenRoom } = await import("../../lib/dm/bus.ts");
const { currentBinding, watchBoundText, _resetComposerBindingForTests } = await import("../../lib/composerBinding.ts");
const { registerPaneTarget, setActivePane, _resetWindowLayerForTests } = await import("../../lib/chrome/windowLayer.ts");
const { createRoot } = await import("react-dom/client");
(globalThis as unknown as { HTMLElement: unknown }).HTMLElement = dom.window.HTMLElement;

const ME = "@me:site.test";
const CASEY = "@casey:site.test";
const SAM = "@sam:site.test";
const ROOM = "!dm:site.test";
const SAM_ROOM = "!sam:site.test";
const T0 = Date.UTC(2026, 9, 20, 15, 0, 0);
const casey = { matrixId: CASEY, username: "casey", displayName: "Casey" };

type Fake = Record<string, unknown> & { getId: () => string };
function ev(id: string, sender: string, ts: number): Fake {
  const content = { msgtype: "m.text", body: `line ${id}` };
  return {
    getId: () => id, getSender: () => sender, getType: () => "m.room.message", getTs: () => ts,
    isRedacted: () => false, isState: () => false, getContent: () => content, getOriginalContent: () => content,
    getWireContent: () => content, getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}),
    getThread: () => undefined, threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false,
    isDecryptionFailure: () => false, getRoomId: () => ROOM, getStateKey: () => undefined, status: null,
  };
}

type Member = { userId: string; typing: boolean; roomId: string } & Record<string, unknown>;

/** A joined, private DM with casey (in m.direct), and — once `inviteFromSam()` — sam's request. */
function world() {
  const clientEm = new EventEmitter();
  const typingSent: unknown[][] = [];
  const member = (userId: string, roomId: string, membership = "join"): Member => ({
    userId, roomId, membership, typing: false, name: userId.slice(1, userId.indexOf(":")), rawDisplayName: userId.slice(1, userId.indexOf(":")),
    getMxcAvatarUrl: () => null,
    events: { member: { getTs: () => 0, getContent: () => ({ membership, ...(userId === ME ? { is_direct: true } : {}) }) } },
  });
  function makeRoom(roomId: string, members: Member[], events: Fake[], opts: { invite?: string } = {}) {
    const em = new EventEmitter();
    const room = {
      roomId, name: roomId, tags: {} as Record<string, unknown>,
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
      getMyMembership: () => (opts.invite ? "invite" : "join"),
      getDMInviter: () => opts.invite,
      isSpaceRoom: () => false,
      getLastActiveTimestamp: () => T0,
      getUnreadNotificationCount: () => 0,
      getAccountData: () => undefined,
      getEventReadUpTo: () => null,
      hasEncryptionStateEvent: () => false,
      loadMembersIfNeeded: () => Promise.resolve(true),
      currentState: {
        getStateEvents: (...a: unknown[]) => (a.length > 1 ? null : []),
        maySendRedactionForEvent: () => true, maySendStateEvent: () => false, maySendEvent: () => true, getMember: () => null,
      },
      client: null as unknown,
      on: (n: string, f: (...a: unknown[]) => void) => { em.on(n, f); },
      off: (n: string, f: (...a: unknown[]) => void) => { em.off(n, f); },
      removeListener: (n: string, f: (...a: unknown[]) => void) => { em.off(n, f); },
    };
    return room;
  }
  const caseyMember = member(CASEY, ROOM);
  const dm = makeRoom(ROOM, [member(ME, ROOM), caseyMember], [ev("$1", CASEY, T0)]);
  const rooms: ReturnType<typeof makeRoom>[] = [dm];
  const actions: string[] = [];
  const client = {
    getUserId: () => ME,
    getDeviceId: () => "DEV",
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getRooms: () => rooms,
    getAccountData: (t: string) => (t === "m.direct" ? { getContent: () => ({ [CASEY]: [ROOM] }) } : undefined),
    getCrypto: () => null,
    getUser: () => null,
    isUserIgnored: () => false,
    mxcUrlToHttp: () => null,
    getHomeserverUrl: () => "https://matrix.site.test",
    fetchRoomEvent: () => new Promise(() => {}),
    decryptEventIfNeeded: () => Promise.resolve(),
    makeTxnId: () => "t1",
    sendEvent: async () => ({ event_id: "$sent" }),
    sendTyping: async (...a: unknown[]) => { typingSent.push(a); },
    scrollback: async () => {},
    sendReadReceipt: async () => {},
    setRoomReadMarkers: async () => {},
    setAccountData: async (t: string, c: unknown) => { actions.push(`setAccountData ${t} ${Object.keys(c as object).join(",")}`); },
    setRoomTag: async (id: string, tag: string) => { actions.push(`setRoomTag ${id} ${tag}`); },
    deleteRoomTag: async (id: string, tag: string) => { actions.push(`deleteRoomTag ${id} ${tag}`); },
    leave: async (id: string) => { actions.push(`leave ${id}`); },
    on: (n: string, f: (...a: unknown[]) => void) => clientEm.on(n, f),
    off: (n: string, f: (...a: unknown[]) => void) => clientEm.off(n, f),
    removeListener: (n: string, f: (...a: unknown[]) => void) => clientEm.off(n, f),
  };
  dm.client = client;
  setMatrixHandle({ client: client as never, status: "ready", startClient: async () => {} });
  return {
    client, typingSent, caseyMember, actions,
    /** casey starts (or stops) typing, as the SDK's sync delivers it: the room flags her member,
     *  the member's own event is re-emitted on the client, then the m.typing event itself. */
    caseyTypes: (on: boolean) => {
      caseyMember.typing = on;
      clientEm.emit("RoomMember.typing", {}, caseyMember);
      clientEm.emit("event", { getType: () => "m.typing" });
    },
    /** The same, for a member the SDK no longer re-emits: its room state was cloned (a request
     *  accepted in this session, a reset timeline), so only the flag and the m.typing event come. */
    caseyTypesUnhooked: (on: boolean) => {
      caseyMember.typing = on;
      clientEm.emit("event", { getType: () => "m.typing" });
    },
    /** sam's DM request arrives while casey's conversation shows. */
    inviteFromSam: () => {
      const r = makeRoom(SAM_ROOM, [member(ME, SAM_ROOM, "invite"), member(SAM, SAM_ROOM)], [], { invite: SAM });
      r.client = client;
      rooms.push(r);
      clientEm.emit("Room.myMembership", r, "invite", "leave");
    },
    done: () => setMatrixHandle({ client: null, status: "idle", startClient: async () => {} }),
  };
}

/** /api/presence answers casey as here, in the community; anything else is a plain ok. */
function servePresence() {
  const now = new Date().toISOString();
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string) => Promise.resolve(new Response(JSON.stringify(
    String(url).startsWith("/api/presence")
      ? { counts: { onSite: 1, inCommunity: 1 }, users: { [CASEY]: { lastBeat: now, lastVisible: now, lastCommunity: now, lastLogin: null, status: "online", statusText: "", supporter: false } } }
      : { banned: false },
  ), { status: 200, headers: { "content-type": "application/json" } }));
}

const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function openHost(props: { onOpenCard?: (who: { matrixId: string; username: string }) => void } = {}) {
  resetStorage();
  servePresence();
  _resetComposerBindingForTests();
  dom.window.document.body.replaceChildren();
  _resetWindowLayerForTests();
  const layer = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(layer);
  registerPaneTarget("live", layer);
  setActivePane("live");
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(DmHost, { onOpenCard: props.onOpenCard ?? (() => {}) })); });
  await act(async () => { requestDm({ kind: "open", to: casey }); });
  for (let i = 0; i < 4; i++) await settle();
  const q = (s: string) => dom.window.document.querySelector(s) as HTMLElement | null;
  return { q, unmount: async () => { await act(async () => { root.unmount(); }); layer.remove(); host.remove(); } };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });

test("header shows Avatar + PresenceDot; title tap calls onOpenCard with the partner", async () => {
  const w = world();
  const opened: unknown[] = [];
  const m = await openHost({ onOpenCard: (who) => opened.push(who) });
  try {
    const mark = m.q('[role="dialog"] .chrome-window-mark')!;
    assert.ok(mark, "the band has its mark");
    assert.ok(mark.querySelector("[data-letter-circle], img"), "casey's picture (her letter, with no picture set)");
    const dot = mark.querySelector("[data-presence]");
    assert.ok(dot, "her presence dot beside it");
    assert.equal(dot!.getAttribute("data-presence"), "community", "here, in the community: the green dot");
    assert.equal(dot!.getAttribute("title"), "In the community", "the dot says what it means");
    const title = m.q('[role="dialog"] button.chrome-window-title')!;
    assert.ok(title, "the name is a button");
    assert.equal(title.textContent, "casey");
    await click(title);
    assert.deepEqual(opened, [{ matrixId: CASEY, username: "casey" }], "her card opens");
  } finally {
    await m.unmount();
    w.done();
  }
});

test("member typing shows TypingLine", async () => {
  const w = world();
  const m = await openHost();
  try {
    assert.doesNotMatch(m.q("[data-dm-window]")!.textContent ?? "", /typing/, "nobody typing: no line");
    await act(async () => { w.caseyTypes(true); });
    const line = m.q("[data-dm-window] [aria-live='polite']");
    assert.equal(line?.textContent, "casey is typing…");
    await act(async () => { w.caseyTypes(false); });
    assert.equal(m.q("[data-dm-window] [aria-live='polite']"), null, "she stopped: the line goes");
  } finally {
    await m.unmount();
    w.done();
  }
});

// Seen on the throwaway pair 2026-10-30: the person who ACCEPTED a request never saw the other one
// typing (in the window and in the Community timeline alike) — their client flagged the member and
// received m.typing, but never re-emitted the member's event (matrix-js-sdk hooks members only on
// NewMember; a cloned room state brings none).
test("restart: typing shows for a member whose event the SDK no longer re-emits (a request accepted in this session)", async () => {
  const w = world();
  const m = await openHost();
  try {
    await act(async () => { w.caseyTypesUnhooked(true); });
    assert.equal(m.q("[data-dm-window] [aria-live='polite']")?.textContent, "casey is typing…");
    await act(async () => { w.caseyTypesUnhooked(false); });
    assert.equal(m.q("[data-dm-window] [aria-live='polite']"), null);
  } finally {
    await m.unmount();
    w.done();
  }
});

test("our typing goes out from the bound chat box's text, and stops when the box empties or the switch is off", async () => {
  const w = world();
  const m = await openHost();
  try {
    const b = currentBinding();
    assert.ok(b && b.kind === "sendTo", "the box is bound to casey");
    await act(async () => { b!.onText?.("hel"); });
    assert.deepEqual(w.typingSent, [[ROOM, true, 30_000]], "typing announced into her room");
    await act(async () => { b!.onText?.(""); });
    assert.deepEqual(w.typingSent.at(-1), [ROOM, false, 0], "the box emptied (sent, or cleared): withdrawn");
    await act(async () => { b!.onText?.("/help"); });
    assert.equal(w.typingSent.length, 2, "a command is not a line to her: no typing");
    dom.window.localStorage.setItem("chatStyle_mxTyping", "0");
    await act(async () => { b!.onText?.("quiet"); });
    assert.equal(w.typingSent.length, 2, "Community › Privacy › Send typing off: nothing goes");
  } finally {
    dom.window.localStorage.removeItem("chatStyle_mxTyping");
    await m.unmount();
    w.done();
  }
});

test("queue of one shows '+1 · name'; tap switches", async () => {
  const w = world();
  const m = await openHost();
  try {
    assert.equal(m.q("[data-dm-waiting]"), null, "nobody waiting: no chip");
    await act(async () => { w.inviteFromSam(); });
    await settle();
    const chip = m.q("[data-dm-waiting]")!;
    assert.ok(chip, "sam's conversation waits, and the band says so");
    assert.equal(chip.textContent, "+1 · sam");
    assert.equal(chip.getAttribute("aria-label"), "Switch to sam's conversation (1 waiting)");
    await click(chip);
    await settle();
    assert.match(m.q('[role="dialog"]')!.textContent ?? "", /sam wants to send you messages/, "sam's request shows");
    assert.equal(m.q("[data-dm-waiting]")?.textContent, "+1 · casey", "casey's waits behind it now");
    await click(m.q("[data-dm-waiting]")!);
    for (let i = 0; i < 3; i++) await settle();
    assert.ok(m.q("[data-dm-window] [data-event-id='$1']"), "back to casey's conversation");
    assert.equal(m.q("[data-dm-waiting]")?.textContent, "+1 · sam");
  } finally {
    await m.unmount();
    w.done();
  }
});

test("retry: a line typed for casey goes with her conversation when switching away (never to Live) and comes back to the box", async () => {
  const w = world();
  const m = await openHost();
  let box = "";
  const unwatch = watchBoundText(() => box, (t) => { box = t; });
  try {
    box = "see you at 8";
    await act(async () => { w.inviteFromSam(); });
    await settle();
    await click(m.q("[data-dm-waiting]")!);
    await settle();
    assert.equal(box, "", "the box let go of casey's line: Enter now cannot post it to Live");
    assert.equal(currentBinding(), null, "sam's request holds no box");
    await click(m.q("[data-dm-waiting]")!);
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(box, "see you at 8", "back on casey: her line is in the box again");
    assert.equal(currentBinding()?.windowId.startsWith("dm:"), true);
  } finally {
    unwatch();
    await m.unmount();
    w.done();
  }
});

test("Open in Community calls requestOpenRoom(id)", async () => {
  const w = world();
  const m = await openHost();
  try {
    takeOpenRoom();
    const open = m.q('[role="dialog"] button[aria-label="Open in Community"]')!;
    assert.ok(open, "the band offers the full conversation");
    await click(open);
    assert.equal(takeOpenRoom(), ROOM, "the room is handed to the Matrix tab");
    assert.ok(m.q("[data-dm-window]"), "the window stays: the box still answers casey");
  } finally {
    await m.unmount();
    w.done();
  }
});

test("the chat column wires it: DmHost opens the user card, the Matrix tab takes the room on the signal and on mount", () => {
  const read = (p: string) => stripComments(readFileSync(new URL(p, import.meta.url), "utf8"));
  const side = read("../chat/ChatSidebar.tsx");
  assert.match(side, /<DmHost onOpenCard=\{openDmCard\} \/>/);
  assert.match(side, /onOpenRoomRequest\(\(\) => \{ setContentTab\(null\); setTab\("matrix"\); setMatrixOpened\(true\); \}\)/);
  const mv = read("../community/MatrixView.tsx");
  assert.match(mv, /const id = takeOpenRoom\(\);/, "the view takes the parked room");
  assert.match(mv, /onOpenRoomRequest\(\(\) => \{ void Promise\.resolve\(\)\.then\(openRequested\); \}\)/, "on the signal");
  assert.match(mv, /useEffect\(\(\) => \{ void Promise\.resolve\(\)\.then\(openRequested\); \}, \[openRequested\]\);/, "and on mount, once the client is ready");
  const input = read("../chat/ChatInput.tsx");
  assert.match(input, /if \(binding\?\.kind === "sendTo"\) binding\.onText\?\.\(input\);/, "the box reports its text to the window holding it");
  assert.match(side, /\}\s*$/, "vacuity anchor: ChatSidebar.tsx read to the end");
  assert.match(mv, /\}\s*$/, "vacuity anchor: MatrixView.tsx read to the end");
  assert.match(input, /\}\s*$/, "vacuity anchor: ChatInput.tsx read to the end");
});

// Task 20 (k's item 11): the window's own sheet offers what the DM list's row does — Pin, Close
// (hidden until they write again) and Leave (behind a confirm) — and Close / Leave put the window away.
test("the band's Conversation options: Pin, Close, Leave; Close hides the person and the window goes", async () => {
  const w = world();
  const m = await openHost();
  try {
    const more = m.q('[role="dialog"] button[aria-label="Conversation options"]');
    assert.ok(more, "the band has the options button");
    await click(more!);
    const items = [...dom.window.document.querySelectorAll("[data-dm-actions] [role=menuitem]")].map((b) => b.textContent);
    assert.deepEqual(items, ["Pin conversation", "Close conversationHidden until they write again.", "Leave conversation"]);
    await click([...dom.window.document.querySelectorAll("[data-dm-actions] [role=menuitem]")][1]!);
    for (let i = 0; i < 20; i++) await settle();
    assert.deepEqual(w.actions, [`setAccountData app.blackbranch.dm_closed ${CASEY}`]);
    assert.equal(m.q('[role="dialog"]'), null, "the window is put away");
  } finally {
    await m.unmount();
    w.done();
  }
});

test("the band's Leave asks first, then leaves the conversation and the window goes", async () => {
  const w = world();
  const m = await openHost();
  try {
    await click(m.q('[role="dialog"] button[aria-label="Conversation options"]')!);
    await click([...dom.window.document.querySelectorAll("[data-dm-actions] [role=menuitem]")][2]!);
    assert.deepEqual(w.actions, [], "it asks first");
    const confirm = dom.window.document.querySelector("[data-dm-leave-confirm]")!;
    assert.match(confirm.textContent ?? "", /Leave your conversation with casey\? They will see that you left\./);
    await click([...confirm.querySelectorAll("button")].find((b) => b.textContent === "Leave")!);
    for (let i = 0; i < 20; i++) await settle();
    assert.deepEqual(w.actions, [`leave ${ROOM}`]);
    assert.equal(m.q('[role="dialog"]'), null);
  } finally {
    await m.unmount();
    w.done();
  }
});
