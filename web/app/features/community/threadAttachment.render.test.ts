// A file sent from a thread's reply box lands IN that thread (Task 10b). Before, the
// composer was never told which thread it sat in, so a picked file posted to the main
// channel with no relation — and in a forum, a file "reply" became a new post.
//  • the thread panel: the file carries the m.thread relation to the root, its caption with it;
//  • the forum Reply dialog: the same, and the dialog closes once the file is posted;
//  • switching the panel to another thread drops a waiting file (the panel is reused, not remounted).
// Real components on stub clients, the context swapped as replySendFailure.render.test.ts does.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/features/community/threadAttachment.render.test.ts
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
      "export function useMatrixClient() { return globalThis.__threadFileCtx; }\n" +
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
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const ROOM_ID = "!general:site.test";
const ME = "@me:site.test";

function message(id: string, body: string, extra: Record<string, unknown> = {}) {
  const content = { msgtype: "m.text", body, ...extra };
  return {
    getId: () => id, getSender: () => ME, getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 10, 6, 12, 0, 0), isRedacted: () => false, isState: () => false,
    getContent: () => content, getOriginalContent: () => content, getWireContent: () => content,
    getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}), getThread: () => undefined,
    threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false, isDecryptionFailure: () => false,
    getRoomId: () => ROOM_ID, getStateKey: () => undefined, status: null,
  };
}

function setup() {
  // The thread so far: a root and one reply.
  const events = [message("$root", "the root"), message("$r1", "first reply", { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } })];
  const room = Object.assign(new EventEmitter(), {
    roomId: ROOM_ID,
    name: "general",
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
  const sent: { roomId: string; content: Record<string, unknown> }[] = [];
  const uploads: string[] = [];
  let n = 0;
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
    makeTxnId: () => `t${++n}`,
    getMediaConfig: async () => ({ "m.upload.size": 10 * 1024 * 1024 }),
    uploadContent: async (_f: unknown, opts: { name: string }) => { uploads.push(opts.name); return { content_uri: `mxc://site.test/u${uploads.length}` }; },
    sendEvent: async (roomId: string, _type: string, content: Record<string, unknown>) => {
      sent.push({ roomId, content });
      return { event_id: `$sent${sent.length}` };
    },
    on: noop,
    off: noop,
    removeListener: noop,
  };
  (globalThis as unknown as { __threadFileCtx: unknown }).__threadFileCtx = {
    client, status: "ready", startClient: async () => {}, retry: noop,
    pendingVerification: null, clearPendingVerification: noop, matrixId: ME, identityKnown: true,
  };
  return { room, events, sent, uploads };
}

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });

async function mount(el: React.ReactElement) {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(el); });
  return {
    host,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next); }); await settle(); },
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const doc = () => dom.window.document;
const textFile = (name = "notes.txt") => new File(["hello"], name, { type: "text/plain" });
const chips = () => [...doc().querySelectorAll("[data-attachment-chip]")].map((c) => c.getAttribute("data-attachment-chip"));

async function pick(file: File) {
  const input = [...doc().querySelectorAll('input[type="file"]')].at(-1) as HTMLInputElement;
  assert.ok(input, "the thread's composer has a file input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await settle();
}

async function typeAndEnter(text: string) {
  const box = [...doc().querySelectorAll("textarea")].at(-1) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(box, text);
    box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    box.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  await settle();
}

const inThread = (fallback: string) => ({ rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: fallback } });

test("thread panel: a file sent from the reply box lands in the thread, caption and all", async () => {
  const s = setup();
  const m = await mount(React.createElement(ThreadPanel as never, { room: s.room, rootEvent: s.events[0], myUserId: ME, onClose: noop }));
  try {
    await pick(textFile());
    await typeAndEnter("see attached");
    assert.deepEqual(s.uploads, ["notes.txt"]);
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0]!.roomId, ROOM_ID);
    assert.deepEqual(s.sent[0]!.content["m.relates_to"], inThread("$r1"), "tied to the root, falling back to the thread's newest reply");
    assert.equal(s.sent[0]!.content.body, "see attached");
    assert.equal(s.sent[0]!.content.filename, "notes.txt");
  } finally {
    await m.unmount();
  }
});

test("thread panel: switching to another thread drops the waiting file", async () => {
  const s = setup();
  s.events.push(message("$other", "another root"));
  const m = await mount(React.createElement(ThreadPanel as never, { room: s.room, rootEvent: s.events[0], myUserId: ME, onClose: noop }));
  try {
    await pick(textFile());
    assert.deepEqual(chips(), ["notes.txt"]);
    await m.rerender(React.createElement(ThreadPanel as never, { room: s.room, rootEvent: s.events[2], myUserId: ME, onClose: noop }));
    assert.deepEqual(chips(), [], "the file staged for one thread never posts into another");
    assert.deepEqual(s.sent, []);
  } finally {
    await m.unmount();
  }
});

test("forum Reply dialog: a file reply is a reply, not a new post, and the dialog finishes", async () => {
  const s = setup();
  const done: unknown[] = [];
  const m = await mount(React.createElement(ForumActionHost as never, {
    action: { kind: "reply", roomId: ROOM_ID, rootId: "$root", latestId: "$r1", rootSenderName: "casey" },
    onDone: (id: unknown) => done.push(id),
    onClose: noop,
  }));
  try {
    await pick(textFile("map.txt"));
    await typeAndEnter("here");
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0]!.content["m.relates_to"], inThread("$r1"));
    assert.deepEqual(done, ["$sent1"], "the dialog is done with the posted reply, as a typed one is");
  } finally {
    await m.unmount();
  }
});
