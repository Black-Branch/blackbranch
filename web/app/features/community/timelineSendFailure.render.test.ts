// A send that fails leaves the composer EMPTY: the failed message stays in the
// list as a "Not sent" row (it carries the text and the Retry), so putting the
// text back in the box as well would make a second press send it twice. The
// real MatrixTimeline, mounted on a stub client whose sendEvent rejects.
//
// The client reaches the timeline through useMatrixClient(); this file swaps
// that one hook (and only it) for the stub by resolving the context module to
// a shim that re-exports the real one.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/features/community/timelineSendFailure.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
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
      "export function useMatrixClient() { return globalThis.__timelineTestCtx; }\n",
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
// jsdom reports "prerender"; the viewer has the tab in front of them.
Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
installRafStub();
(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const { MatrixTimeline } = await import("./Timeline.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const liveEvents: unknown[] = [];
const ROOM_ID = "!general:site.test";
const ME = "@me:site.test";
const room = {
  roomId: ROOM_ID,
  name: "general",
  getLiveTimeline: () => ({ getEvents: () => liveEvents, getPaginationToken: () => null }),
  getThreads: () => [],
  findEventById: () => null,
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
    // (type) → a list; (type, stateKey) → one event or null, as the SDK does.
    getStateEvents: (...a: unknown[]) => (a.length > 1 ? null : []),
    maySendRedactionForEvent: () => true,
    maySendStateEvent: () => false,
    maySendEvent: () => true,
    getMember: () => null,
  },
  on: noop,
  off: noop,
};
const sent: unknown[] = [];
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
  sendEvent: (...a: unknown[]) => { sent.push(a); return Promise.reject(new Error("offline")); },
  on: noop,
  off: noop,
  removeListener: noop,
};
(globalThis as unknown as { __timelineTestCtx: unknown }).__timelineTestCtx = {
  client, status: "ready", startClient: async () => {}, retry: noop,
  pendingVerification: null, clearPendingVerification: noop, matrixId: ME, identityKnown: true,
};

function typeInto(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("when sendEvent rejects, the composer value is \"\"", async () => {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    await act(async () => {
      root.render(React.createElement(MatrixTimeline as never, { room, myUserId: ME, serverRooms: [room] }));
    });
    const box = host.querySelector("textarea") as HTMLTextAreaElement | null;
    assert.ok(box, "the composer rendered");
    await act(async () => { typeInto(box!, "probe"); });
    assert.equal(box!.value, "probe", "the harness can type");
    const form = box!.closest("form")!;
    await act(async () => {
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(sent.length, 1, "the send was attempted");
    assert.equal(box!.value, "", "a failed send must not put the text back — the Not sent row carries it");
    assert.equal(box!.disabled, false, "the composer is usable again");
  } finally {
    console.error = orig;
    await act(async () => { root.unmount(); });
    host.remove();
  }
});

async function mountTimeline(props: Record<string, unknown> = {}) {
  resetStorage();
  serveJson({});
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(MatrixTimeline as never, { room, myUserId: ME, serverRooms: [room], ...props }));
  });
  return { host, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("the timeline passes each row its send state: our own not_sent message shows Not sent with Retry", async () => {
  const content = { msgtype: "m.text", body: "probe" };
  liveEvents.push({
    getId: () => `~${ROOM_ID}:m1`, getSender: () => ME, getType: () => "m.room.message",
    getTs: () => Date.UTC(2026, 9, 24, 12, 0, 0), isRedacted: () => false, isState: () => false,
    getContent: () => content, getOriginalContent: () => content, getWireContent: () => content,
    getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}), getThread: () => undefined,
    threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false, isDecryptionFailure: () => false,
    getRoomId: () => ROOM_ID, getStateKey: () => undefined, status: "not_sent",
  });
  const m = await mountTimeline();
  try {
    const row = m.host.querySelector(`[data-event-id="~${ROOM_ID}:m1"]`);
    assert.ok(row, "the echo is a row");
    assert.match(row!.querySelector('[role="status"]')?.textContent ?? "", /Not sent.*Retry.*Delete/);
  } finally {
    liveEvents.length = 0;
    await m.unmount();
  }
});

test("the open timeline counts as on screen exactly while its list is in front of the person — never by layout", async () => {
  const { roomOnScreen } = await import("../../lib/dm/bus.ts");
  // jsdom lays nothing out: give elements a box, here inside the 390-wide viewport.
  const proto = dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => unknown };
  const origRect = proto.getBoundingClientRect;
  let box = { left: 0, top: 0, right: 390, bottom: 700, width: 390, height: 700 };
  proto.getBoundingClientRect = () => box;
  Object.defineProperty(dom.window, "innerWidth", { value: 390, configurable: true });
  Object.defineProperty(dom.window, "innerHeight", { value: 844, configurable: true });
  try {
    const m = await mountTimeline({ compact: true });
    assert.equal(roomOnScreen(), ROOM_ID, "the Matrix tab is showing: no window over this conversation");
    // The chat column pages to Live: the Matrix pane becomes inert. Same narrow ("compact") layout —
    // the layout flag must not decide, or a DM for this room is swallowed while the person is on Live.
    m.host.setAttribute("inert", "");
    assert.equal(roomOnScreen(), null, "the pane is paged away: a DM opens its window");
    m.host.removeAttribute("inert");
    box = { left: 390, top: 0, right: 780, bottom: 700, width: 390, height: 700 };
    assert.equal(roomOnScreen(), null, "laid out off to the side: not on screen");
    box = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    assert.equal(roomOnScreen(), null, "a hidden tab has no box");
    box = { left: 0, top: 0, right: 390, bottom: 700, width: 390, height: 700 };
    assert.equal(roomOnScreen(), ROOM_ID);
    await m.unmount();
    assert.equal(roomOnScreen(), null, "gone with it");
  } finally {
    proto.getBoundingClientRect = origRect;
  }
});
