// The community's two other composers keep the one rule (Task 1): a reply that fails to send
// stays in view, marked "Not sent · Retry · Delete", and the box is EMPTY — refilling it as well
// let a second press send the same reply twice.
//  • the thread panel: the failed reply is a row with Retry/Delete;
//  • a forum reply from the Forums tab: the dialog keeps the failed reply with Retry/Delete.
// Real components on stub clients; the client reaches them through useMatrixClient(), which this
// file swaps (with useStartMatrixClient) by resolving the context module to a shim.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/features/community/replySendFailure.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage, serveJson } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM =
  "data:text/javascript," +
  encodeURIComponent(
    `export * from ${JSON.stringify(REAL_CTX)};\n` +
      "export function useMatrixClient() { return globalThis.__replyTestCtx; }\n" +
      "export function useStartMatrixClient() {}\n",
  );
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) {
      return { url: SHIM, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

installResizeObserverStub();
installRafStub();
(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const { ThreadPanel } = await import("./ThreadPanel.tsx");
const { ForumActionHost } = await import("./ForumActionHost.tsx");
const { DmDraftPane } = await import("./DmDraftPane.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const ROOM_ID = "!forum:site.test";
const ME = "@me:site.test";
const ROOT = "$root";

function message(id: string, body: string, extra: Record<string, unknown> = {}, status: string | null = null) {
  const content = { msgtype: "m.text", body, ...extra };
  return {
    getId: () => id, getSender: () => ME, getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 24, 12, 0, 0), isRedacted: () => false, isState: () => false,
    getContent: () => content, getOriginalContent: () => content, getWireContent: () => content,
    getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}), getThread: () => undefined,
    threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false, isDecryptionFailure: () => false,
    getRoomId: () => ROOM_ID, getStateKey: () => undefined, status,
  };
}

function setup() {
  const events: ReturnType<typeof message>[] = [];
  const room = Object.assign(new EventEmitter(), {
    roomId: ROOM_ID,
    name: "forum",
    getLiveTimeline: () => ({ getEvents: () => events, getPaginationToken: () => null }),
    getThreads: () => [],
    getThread: () => null,
    findEventById: (id: string) => events.find((e) => e.getId() === id) ?? null,
    getMember: (id: string) => ({ userId: id, name: "me", rawDisplayName: "me", getMxcAvatarUrl: () => null, events: {}, membership: "join" }),
    getJoinedMembers: () => [],
    getMembers: () => [],
    getJoinedMemberCount: () => 1,
    getMyMembership: () => "join",
    getDMInviter: () => undefined,
    getAccountData: () => undefined,
    getEventReadUpTo: () => null,
    getUnreadNotificationCount: () => 0,
    getType: () => undefined,
    hasEncryptionStateEvent: () => false,
    loadMembersIfNeeded: () => Promise.resolve(true),
    currentState: {
      getStateEvents: (...a: unknown[]) => (a.length > 1 ? null : []),
      maySendRedactionForEvent: () => true,
      maySendStateEvent: () => false,
      maySendEvent: () => true,
      getMember: () => null,
    },
  });
  const sent: unknown[][] = [];
  const resent: unknown[] = [];
  let txn = 0;
  const client = {
    getUserId: () => ME,
    getDeviceId: () => "DEV",
    getRoom: () => room,
    getRooms: () => [room],
    getAccountData: () => undefined,
    getPushRules: () => undefined,
    getCrypto: () => undefined,
    isRoomEncrypted: () => false,
    sendTyping: () => Promise.resolve({}),
    sendReadReceipt: () => Promise.resolve({}),
    setRoomReadMarkers: () => Promise.resolve({}),
    getHomeserverUrl: () => "https://matrix.site.test",
    mxcUrlToHttp: () => null,
    makeTxnId: () => `t${++txn}`,
    // As the SDK does: the echo lands in the live timeline first, then the send fails.
    sendEvent: (roomId: string, _type: string, content: Record<string, unknown>, txnId?: string) => {
      sent.push([roomId, content, txnId]);
      const echo = message(`~${roomId}:${txnId ?? `x${sent.length}`}`, String(content.body), { "m.relates_to": content["m.relates_to"] }, "not_sent");
      events.push(echo);
      room.emit("Room.localEchoUpdated", echo, room);
      return Promise.reject(new Error("fetch failed: Failed to fetch"));
    },
    resendEvent: (ev: { status: string | null; getId: () => string }) => { resent.push(ev); ev.status = "sent"; return Promise.resolve({ event_id: "$sent" }); },
    on: noop,
    off: noop,
    removeListener: noop,
  };
  (globalThis as unknown as { __replyTestCtx: unknown }).__replyTestCtx = {
    client, status: "ready", startClient: async () => {}, retry: noop,
    pendingVerification: null, clearPendingVerification: noop, matrixId: ME, identityKnown: true,
  };
  return { room, client, events, sent, resent };
}

function typeInto(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

async function mount(el: React.ReactElement) {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

async function submitFrom(host: Element, text: string) {
  const box = [...host.ownerDocument.querySelectorAll("textarea")].at(-1) as HTMLTextAreaElement;
  assert.ok(box, "the composer rendered");
  await act(async () => { typeInto(box, text); });
  await act(async () => { box.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return box;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
}

test("a thread reply that fails: the box is empty and the reply is a Not sent row with Retry", async () => {
  const s = setup();
  const rootEvent = message(ROOT, "the post");
  const m = await mount(React.createElement(ThreadPanel as never, { room: s.room, rootEvent, myUserId: ME, onClose: noop }));
  try {
    const box = await quiet(() => submitFrom(m.host, "my reply"));
    assert.equal(s.sent.length, 1, "the send was attempted");
    assert.equal(box.value, "", "the box is not refilled — the row carries the text");
    const row = m.host.querySelector(`[data-event-id^="~${ROOM_ID}:"]`);
    assert.ok(row, "the failed reply is a row in the thread");
    const status = row!.querySelector('[role="status"]');
    assert.match(status?.textContent ?? "", /Not sent.*Retry.*Delete/);
    await act(async () => { [...status!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(s.resent.length, 1, "Retry resends the same echo");
  } finally {
    await m.unmount();
  }
});

test("a forum reply that fails: the dialog keeps it as Not sent with Retry, the box is empty; Retry that lands finishes the reply", async () => {
  const s = setup();
  const done: unknown[] = [];
  const m = await mount(React.createElement(ForumActionHost as never, {
    action: { kind: "reply", roomId: ROOM_ID, rootId: ROOT, latestId: ROOT, rootSenderName: "casey" },
    onDone: (id: unknown) => done.push(id),
    onClose: noop,
  }));
  try {
    const box = await quiet(() => submitFrom(m.host, "forum reply"));
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]![2], "t1", "sent with our own txn id, so the echo can be found");
    assert.equal(box.value, "", "the box is not refilled");
    const doc = m.host.ownerDocument;
    const status = doc.querySelector('[role="dialog"] [role="status"]');
    assert.match(status?.textContent ?? "", /Not sent.*Retry.*Delete/);
    assert.match(doc.querySelector('[role="dialog"]')!.textContent ?? "", /forum reply/, "the failed reply's text is shown");
    assert.deepEqual(done, [], "not done: nothing was posted");
    await act(async () => { [...status!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(s.resent.length, 1);
    assert.equal(done.length, 1, "a Retry that lands finishes the reply like a first-time send");
  } finally {
    await m.unmount();
  }
});

test("a forum reply's Delete drops the echo and leaves an empty composer", async () => {
  const s = setup();
  const cancelled: unknown[] = [];
  Object.assign(s.client, { cancelPendingEvent: (ev: unknown) => { cancelled.push(ev); } });
  const m = await mount(React.createElement(ForumActionHost as never, {
    action: { kind: "reply", roomId: ROOM_ID, rootId: ROOT, latestId: ROOT, rootSenderName: "casey" },
    onDone: noop,
    onClose: noop,
  }));
  try {
    await quiet(() => submitFrom(m.host, "drop me"));
    const doc = m.host.ownerDocument;
    const status = doc.querySelector('[role="dialog"] [role="status"]')!;
    await act(async () => { [...status.querySelectorAll("button")].find((b) => b.textContent === "Delete")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.equal(cancelled.length, 1);
    assert.equal(doc.querySelector('[role="dialog"] [role="status"]'), null, "the failed reply is gone");
  } finally {
    await m.unmount();
  }
});

test("a thread reply that fails before any line was made keeps its text in the box (nothing else holds it)", async () => {
  const s = setup();
  Object.assign(s.client, { sendEvent: () => Promise.reject(new Error("refused before sending")) });
  const m = await mount(React.createElement(ThreadPanel as never, { room: s.room, rootEvent: message(ROOT, "the post"), myUserId: ME, onClose: noop }));
  try {
    const box = await quiet(() => submitFrom(m.host, "keep me"));
    assert.equal(box.value, "keep me");
  } finally {
    await m.unmount();
  }
});

/** A client with no DM with Casey yet: createRoom makes a fresh private one (me joined, Casey invited). */
function draftWorld() {
  const CASEY = "@casey:site.test";
  const rooms: unknown[] = [];
  const calls: string[] = [];
  let account: Record<string, string[]> = {};
  const privateRoom = (roomId: string) => {
    const members = [{ userId: ME, membership: "join" }, { userId: CASEY, membership: "invite" }];
    return Object.assign(new EventEmitter(), {
      roomId,
      getMyMembership: () => "join", isSpaceRoom: () => false, getDMInviter: () => undefined,
      getMembers: () => members, getJoinedMemberCount: () => 1, getInvitedMemberCount: () => 1,
      getJoinRule: () => "invite", getHistoryVisibility: () => "shared", getLastActiveTimestamp: () => 0,
      loadMembersIfNeeded: async () => true,
      getMember: (id: string) => {
        const m = members.find((x) => x.userId === id);
        return m ? { ...m, events: { member: { getContent: () => ({ membership: m.membership, ...(id === CASEY ? { is_direct: true } : {}) }) } } } : null;
      },
      currentState: { getStateEvents: () => ({ getTs: () => 0, getSender: () => ME }) },
      findEventById: () => null,
    });
  };
  const client = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => (rooms as { roomId: string }[]).find((r) => r.roomId === id) ?? null,
    getAccountData: () => ({ getContent: () => account }),
    setAccountData: async (_t: string, c: Record<string, string[]>) => { account = c; },
    createRoom: async () => { calls.push("createRoom"); rooms.push(privateRoom("!made")); return { room_id: "!made" }; },
    makeTxnId: () => "t1",
    sendEvent: async (roomId: string) => { calls.push(`send ${roomId}`); return { event_id: "$1" }; },
    on: noop, off: noop,
  };
  return { client, calls, CASEY };
}

test("Community's DM draft (no chat column): opening makes nothing; the first line makes ONE room and sends once", async () => {
  const w = draftWorld();
  const opened: { roomId: string }[] = [];
  const m = await mount(React.createElement(DmDraftPane as never, { client: w.client, userId: w.CASEY, name: "casey", onOpened: (r: { roomId: string }) => opened.push(r) }));
  try {
    assert.match(m.host.textContent ?? "", /This is the start of your conversation with casey\./);
    assert.deepEqual(w.calls, [], "opening made no room and sent no request");
    await submitFrom(m.host, "hi casey");
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.deepEqual(w.calls, ["createRoom", "send !made"], "one room, one line");
    assert.deepEqual(opened.map((r) => r.roomId), ["!made"], "the conversation opens");
  } finally {
    await m.unmount();
  }
});
