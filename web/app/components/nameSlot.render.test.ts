// No name slot can widen the page (client polish Task 9, k's item 7a).
//
// A banned bridge puppet showed as its raw id and, one unbroken string, pushed the page wider than
// the phone at 390 px. A display name is anyone's text, so every element that prints one must be
// able to get narrower than the name: the name's box carries `truncate` (one line, cut with "…") or
// `overflow-wrap: anywhere` (where the name may wrap), and that box is `min-w-0` itself or sits in a
// `min-w-0` parent, because a flex item never shrinks below its content without it.
//
// This mounts each REAL slot with a 60-character unbroken name and checks the classes the boxes are
// built from; jsdom has no layout. The pixels are the Look's (look/09-names.mjs on the throwaway
// pair: `document.documentElement.scrollWidth === 390`).
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/components/nameSlot.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act } from "../lib/testDom.ts";
import "../lib/testTsx.ts";
import { fakeRoom, fakeClient, ME } from "../lib/fixtures/dmThreeRooms.ts";

// Community slots reach the client through useMatrixClient(); that one hook is swapped for a fixed
// context by resolving the context module to a shim that re-exports the real one.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM = "data:text/javascript," + encodeURIComponent(
  `export * from ${JSON.stringify(REAL_CTX)};\n` +
  `export function useMatrixClient() { return globalThis.__nameSlotCtx; }\n` +
  `export function useMatrixIdentity() { return { matrixId: ${JSON.stringify(ME)}, identityKnown: true }; }\n`,
);
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as unknown as { fetch: () => Promise<never> }).fetch = () => new Promise<never>(() => {});
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} disconnect() {} unobserve() {} };
(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle ??= dom.window.getComputedStyle.bind(dom.window);

const { MatrixMessageRow } = await import("./MatrixMessageRow.tsx");
const { MemberCard } = await import("./MemberCard.tsx");
const { TypingLine } = await import("./TypingLine.tsx");
const { PostCard } = await import("./forum/PostCard.tsx");
const { ThreadView } = await import("./forum/ThreadView.tsx");
const { MemberList } = await import("../features/community/MemberList.tsx");
const { ChannelColumn } = await import("../features/community/ChannelColumn.tsx");
const { ThreadsListPanel } = await import("../features/community/ThreadsListPanel.tsx");
const { PinnedMessages } = await import("../features/community/PinnedMessages.tsx");
const { dmConversations } = await import("../lib/dmConversations.ts");
const { createRoot } = await import("react-dom/client");

// 60 characters, no space or hyphen to break at.
const NAME = "Wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww";
assert.equal(NAME.length, 60);
const LONG = "@wide:site.test";
const noop = () => {};
const asyncNoop = async () => {};

const member = (userId: string, name: string) => ({
  userId, name, rawDisplayName: name, membership: "join", powerLevel: 0, powerLevelNorm: 0,
  getMxcAvatarUrl: () => null, getDMInviter: () => undefined, user: null,
  events: { member: { getContent: () => ({ membership: "join" }), getSender: () => userId } },
});
const wide = member(LONG, NAME);

let n = 0;
function msg(sender: string, content: Record<string, unknown>, ts = Date.UTC(2026, 9, 31, 12, n)) {
  const id = `$m${++n}`;
  return {
    getId: () => id, getSender: () => sender, getType: () => "m.room.message", getTs: () => ts,
    getRoomId: () => "!r:site.test", isRedacted: () => false, getContent: () => content,
    getOriginalContent: () => content, getWireContent: () => content, isEncrypted: () => false,
    isDecryptionFailure: () => false, isState: () => false, getStateKey: () => undefined,
    getRelation: () => null, status: null,
  };
}
const original = msg(LONG, { msgtype: "m.text", body: "the original" });
const threadReply = msg(LONG, { msgtype: "m.text", body: "in the thread", "m.relates_to": { rel_type: "m.thread", event_id: original.getId() } });

function room(events: ReturnType<typeof msg>[] = []) {
  return {
    roomId: "!r:site.test", name: "general",
    client: { fetchRoomEvent: () => new Promise(() => {}), decryptEventIfNeeded: () => Promise.resolve(), getUser: () => null, getUserId: () => ME, getAccountData: () => undefined, on: noop, off: noop, removeListener: noop },
    getMember: (id: string) => (id === LONG ? wide : member(id, id.slice(1, id.indexOf(":")))),
    getJoinedMembers: () => [wide],
    loadMembersIfNeeded: async () => true,
    findEventById: (id: string) => [original, threadReply, ...events].find((e) => e.getId() === id),
    currentState: { maySendRedactionForEvent: () => true, getStateEvents: () => [], hasSufficientPowerLevelFor: () => false, maySendStateEvent: () => false },
    getLiveTimeline: () => ({ getEvents: () => [original, threadReply, ...events] }),
    getThreads: () => [], getMyMembership: () => "join", getDMInviter: () => undefined,
    on: noop, off: noop, removeListener: noop,
  };
}

function setCtx(client: unknown) {
  (globalThis as unknown as { __nameSlotCtx: unknown }).__nameSlotCtx = {
    client, status: "ready", startClient: asyncNoop, retry: noop, matrixId: ME, identityKnown: true, offerVerification: asyncNoop,
  };
}
setCtx(fakeClient([]));

async function mount(el: React.ReactElement) {
  // A failed assertion skips its unmount; never let its rows count for the next slot.
  dom.window.document.body.replaceChildren();
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

const BREAKS = (el: Element) => el.classList.contains("truncate") || el.classList.contains("[overflow-wrap:anywhere]");

/** Every element printing NAME as its own text: the name's box (the element, or its parent for an
 *  inline span in a cut line) carries truncate / overflow-wrap:anywhere, and is min-w-0 itself or
 *  sits in a min-w-0 parent (or is an overlay pinned to both sides). */
function assertSlots(host: Element, label: string, name = NAME, min = 1) {
  const holders = [...host.querySelectorAll("*")].filter((el) =>
    [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? "").includes(name)));
  assert.ok(holders.length >= min, `${label}: the name renders (${holders.length} found)`);
  for (const el of holders) {
    const box = BREAKS(el) ? el : el.parentElement && BREAKS(el.parentElement) ? el.parentElement : null;
    assert.ok(box, `${label}: <${el.tagName.toLowerCase()} class="${el.className}"> has no truncate / overflow-wrap:anywhere`);
    // An overlay pinned to both sides (the typing line) has its width from them, not its text.
    const pinned = ["absolute", "left-0", "right-0"].every((c) => box.classList.contains(c));
    const shrinks = pinned || box.classList.contains("min-w-0") || !!box.parentElement?.classList.contains("min-w-0");
    assert.ok(shrinks, `${label}: <${box.tagName.toLowerCase()} class="${box.className}"> is not min-w-0 and has no min-w-0 parent`);
  }
}

test("message row: the name in the head, in a reply quote and in an emote", async () => {
  const r = room();
  const row = (ev: ReturnType<typeof msg>) => React.createElement(MatrixMessageRow as never, { room: r, ev, myUserId: ME, onReply: noop, onReact: noop, onOpenMember: noop });
  const head = await mount(row(msg(LONG, { msgtype: "m.text", body: "hello" })));
  assertSlots(head.host, "head");
  await head.unmount();
  const quote = await mount(row(msg("@casey:site.test", { msgtype: "m.text", body: "> <@wide:site.test> the original\n\nreply", "m.relates_to": { "m.in_reply_to": { event_id: original.getId() } } })));
  assertSlots(quote.host, "reply quote");
  await quote.unmount();
  const emote = await mount(row(msg(LONG, { msgtype: "m.emote", body: "waves" })));
  assertSlots(emote.host, "emote", NAME, 2);
  await emote.unmount();
});

test("member list row and member card", async () => {
  const list = await mount(React.createElement(MemberList as never, { room: room(), myUserId: ME }));
  assertSlots(list.host, "member list");
  await list.unmount();
  const card = await mount(React.createElement(MemberCard as never, {
    member: wide, room: room(), x: 10, y: 10, side: "right", color: "#fff", canMessage: true,
    onMessage: noop, onClose: noop, scopeRooms: [], myUserId: ME,
  }));
  assertSlots(dom.window.document.body, "member card");
  await card.unmount();
});

test("channel column: a DM row and a DM request", async () => {
  const dm = fakeRoom({ roomId: "!dm", creator: ME, created: Date.UTC(2026, 9, 1), members: [{ userId: ME, membership: "join", name: "me", dmInviter: ME }, { userId: LONG, membership: "join", name: NAME }] });
  const req = fakeRoom({ roomId: "!req", creator: "@wider:site.test", created: Date.UTC(2026, 9, 2), myMembership: "invite", inviter: "@wider:site.test",
    members: [{ userId: ME, membership: "invite" }, { userId: "@wider:site.test", membership: "join", name: `${NAME}x` }] });
  const client = fakeClient([dm, req], { "m.direct": { [LONG]: ["!dm"] } });
  setCtx(Object.assign(client, { pushRules: undefined }));
  const col = await mount(React.createElement(ChannelColumn as never, {
    mode: "home", server: null, conversations: dmConversations(client as never, ME, {}), onOpenConversation: noop,
    pinned: [], invites: [req], selected: null, myUserId: ME, onSelect: noop, onAcceptInvite: asyncNoop,
    onRejectInvite: asyncNoop, serverRooms: [],
  }));
  assertSlots(col.host, "DM row");
  assertSlots(col.host, "DM request", `${NAME}x`);
  await col.unmount();
  setCtx(fakeClient([]));
});

test("threads list, pinned messages and the typing line", async () => {
  const r = room();
  setCtx({ ...fakeClient([]), getRoom: () => r });
  const threads = await mount(React.createElement(ThreadsListPanel as never, { room: r, myUserId: ME, onOpenThread: noop, onClose: noop }));
  assertSlots(threads.host, "threads list", NAME, 2);
  await threads.unmount();
  setCtx(fakeClient([]));
  const pins = await mount(React.createElement(PinnedMessages as never, {
    client: null, room: r, ids: [original.getId()], canPin: false, onJump: async () => true, onUnpin: noop, open: true, onClose: noop,
  }));
  assertSlots(dom.window.document.body, "pinned");
  await pins.unmount();
  const typing = await mount(React.createElement(TypingLine as never, { text: `${NAME} is typing…` }));
  assertSlots(typing.host, "typing line");
  await typing.unmount();
});

test("forum: a post card and a thread's authors", async () => {
  const post = {
    roomId: "!r:site.test", roomName: "forum", id: "$p", sender: LONG, senderName: NAME, senderAvatar: null,
    title: "A post", preview: "text", body: "text", formatted: null, tags: [], thumbnail: null,
    replyCount: 0, lastTs: Date.UTC(2026, 9, 31), postedTs: Date.UTC(2026, 9, 31), score: 0, myVote: null, pinned: false,
  };
  const card = await mount(React.createElement(PostCard as never, { post, myUserId: ME, userColors: {}, onOpen: noop, onTogglePin: noop, onVote: noop }));
  assertSlots(card.host, "post card");
  await card.unmount();
  const thread = { root: { ...post, ts: post.postedTs }, replies: [{ id: "$r", sender: LONG, senderName: NAME, senderAvatar: null, ts: post.postedTs, body: "reply", formatted: null }] };
  const view = await mount(React.createElement(ThreadView as never, { thread, loading: false, error: false, onBack: noop, onClose: noop, composer: null, userColors: {} }));
  assertSlots(view.host, "thread view", NAME, 2);
  await view.unmount();
});
