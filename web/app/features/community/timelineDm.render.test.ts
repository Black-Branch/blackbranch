// A DM in the Community timeline (client polish Task 20): at the start of the active room the
// person's earlier room is one tap away; that earlier room opens READ-ONLY (no composer, the way
// back instead), so a line always goes into the room they write in; and a line sent here nudges the
// other person's open pages as the DM window's does (Task 2 round-1 note: Community sends never
// nudged). The real MatrixTimeline on a stub client; useMatrixClient() resolves to a shim.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/features/community/timelineDm.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { dom, React, act, resetStorage } from "../../lib/testDom.ts";
import { installResizeObserverStub, installRafStub } from "../../lib/testTsx.ts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REAL_CTX = pathToFileURL(path.join(WEB, "app", "lib", "MatrixClientContext.tsx")).href;
const SHIM = "data:text/javascript," + encodeURIComponent(
  `export * from ${JSON.stringify(REAL_CTX)};\nexport function useMatrixClient() { return globalThis.__timelineDmCtx; }\n`,
);
type Hooks = { resolve(s: string, c: unknown, next: (s: string, c: unknown) => unknown): unknown };
(nodeModule as unknown as { registerHooks: (h: Hooks) => void }).registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith("file:") && /(^|\/)MatrixClientContext(\.tsx)?$/.test(specifier)) return { url: SHIM, shortCircuit: true };
    return next(specifier, context);
  },
});

installResizeObserverStub();
Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
const raf = installRafStub();
(dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const { MatrixTimeline } = await import("./Timeline.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
const ME = "@me:site.test";
const ROBIN = "@robin:site.test";
const created = { getTs: () => Date.UTC(2026, 7, 5), getType: () => "m.room.create", getSender: () => ME, getContent: () => ({}), getId: () => "$c", isRedacted: () => false, isState: () => true };

function dmRoom(roomId: string) {
  const member = (id: string) => ({ userId: id, name: id === ME ? "me" : "Robin", rawDisplayName: id === ME ? "me" : "Robin", getMxcAvatarUrl: () => null, events: {}, membership: "join" });
  return {
    roomId,
    name: "Robin",
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => null }),
    getThreads: () => [],
    findEventById: () => null,
    getMember: member,
    getJoinedMembers: () => [member(ME), member(ROBIN)],
    getMembers: () => [member(ME), member(ROBIN)],
    getJoinedMemberCount: () => 2,
    getMyMembership: () => "join",
    getDMInviter: () => ROBIN,
    getAccountData: () => undefined,
    getEventReadUpTo: () => null,
    getUnreadNotificationCount: () => 0,
    getType: () => undefined,
    hasEncryptionStateEvent: () => false,
    loadMembersIfNeeded: () => Promise.resolve(true),
    currentState: {
      getStateEvents: (...a: unknown[]) => (a.length > 1 ? (a[0] === "m.room.create" ? created : null) : []),
      maySendRedactionForEvent: () => true,
      maySendStateEvent: () => false,
      maySendEvent: () => true,
      getMember: () => null,
    },
    on: noop,
    off: noop,
  };
}

const active = dmRoom("!active");
const older = dmRoom("!older");
const sent: unknown[] = [];
const client = {
  getUserId: () => ME,
  getDeviceId: () => "DEV",
  getRoom: (id: string) => (id === "!older" ? older : active),
  getRooms: () => [active, older],
  getAccountData: () => undefined,
  getPushRules: () => undefined,
  getCrypto: () => undefined,
  isRoomEncrypted: () => false,
  isUserIgnored: () => false,
  sendTyping: () => Promise.resolve({}),
  sendReadReceipt: () => Promise.resolve({}),
  setRoomReadMarkers: () => Promise.resolve({}),
  getHomeserverUrl: () => "https://matrix.site.test",
  mxcUrlToHttp: () => null,
  // Scroll-back reaches the start at once (no pagination token): hitStart.
  scrollback: (r: unknown) => Promise.resolve(r),
  sendEvent: (...a: unknown[]) => { sent.push(a); return Promise.resolve({ event_id: "$new" }); },
  on: noop,
  off: noop,
  removeListener: noop,
};
(globalThis as unknown as { __timelineDmCtx: unknown }).__timelineDmCtx = {
  client, status: "ready", startClient: async () => {}, retry: noop,
  pendingVerification: null, clearPendingVerification: noop, matrixId: ME, identityKnown: true,
};

const fetches: { url: string; body: string }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
  fetches.push({ url: String(url), body: String(init?.body ?? "") });
  return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
};

async function mount(props: Record<string, unknown>) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(MatrixTimeline as never, { myUserId: ME, serverRooms: [], ...props })); });
  // The loading phase settles: the auto-fill's frame runs, its scroll-back reaches the start.
  for (let i = 0; i < 3; i++) {
    await act(async () => { raf.flush(); await new Promise((r) => setTimeout(r, 10)); });
  }
  return { host, unmount: () => act(async () => { root.unmount(); host.remove(); }) };
}

function typeInto(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
}

test("the active room's start leads to the earlier conversation; a tap opens it", async () => {
  resetStorage();
  const opened: string[] = [];
  const m = await mount({ room: active, earlier: [older], onOpenEarlier: (r: { roomId: string }) => opened.push(r.roomId) });
  const bar = m.host.querySelector("[data-timeline-top] [data-earlier-conversation]");
  assert.ok(bar, "Earlier conversation sits in the top slot at the start");
  await act(async () => { bar!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(opened, ["!older"]);
  assert.ok(m.host.querySelector("textarea"), "the active room keeps its composer");
  await m.unmount();
});

test("an earlier room is read-only: no composer, the way back to the current one", async () => {
  const back: number[] = [];
  const m = await mount({ room: older, onBackToCurrent: () => back.push(1) });
  assert.equal(m.host.querySelector("textarea"), null, "nothing can be sent into the older room");
  const bar = m.host.querySelector("[data-earlier-readonly]")!;
  assert.match(bar.textContent ?? "", /Earlier conversation/);
  assert.equal(bar.querySelector("[title]")?.getAttribute("title"), "An earlier conversation with Robin", "the whole sentence on hover; the bar fits 390 px");
  await act(async () => { bar.querySelector("button")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(back, [1]);
  await m.unmount();
});

test("a line sent into a DM from the Community timeline nudges the other person", async () => {
  fetches.length = 0;
  const m = await mount({ room: active });
  const box = m.host.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => { typeInto(box, "hello"); });
  await act(async () => { box.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  assert.equal(sent.length, 1);
  const ping = fetches.find((f) => f.url === "/api/dm/ping");
  assert.ok(ping, "the nudge went");
  assert.deepEqual(JSON.parse(ping!.body), { to: ROBIN });
  await m.unmount();
});
