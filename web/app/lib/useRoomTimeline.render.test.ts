// useRoomTimeline — the one room-timeline engine the community timeline and the DM window share
// (client polish Task 11): the rendered window over the live timeline, reactions and edits read
// from the RAW timeline, grouping flags, scroll-back at the top, and ONE loading phase.
//
// Mounted for real (a tiny host renders the scroller the hook drives) on a fake client and room.
// jsdom lays nothing out, so each test says what height the scroller has.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G node --test app/lib/useRoomTimeline.render.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dom, React, act } from "./testDom.ts";
import { installResizeObserverStub, installRafStub } from "./testTsx.ts";

installResizeObserverStub();
const raf = installRafStub();
const { useRoomTimeline } = await import("./useRoomTimeline.ts");
const { createRoot } = await import("react-dom/client");

const ME = "@me:site.test";
const CASEY = "@casey:site.test";
const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

type Fake = Record<string, unknown>;
function ev(id: string, sender: string, ts: number, extra: { type?: string; content?: Record<string, unknown>; status?: string | null } = {}): Fake {
  const content = extra.content ?? { msgtype: "m.text", body: id };
  const type = extra.type ?? "m.room.message";
  return {
    getId: () => id, getSender: () => sender, getType: () => type, getTs: () => ts,
    isRedacted: () => false, isState: () => false, getContent: () => content, getOriginalContent: () => content,
    getWireContent: () => content, getRelation: () => null, isRelation: () => false, getUnsigned: () => ({}),
    getThread: () => undefined, threadRootId: undefined, isThreadRoot: false, isEncrypted: () => false,
    isDecryptionFailure: () => false, getRoomId: () => "!r", getStateKey: () => undefined, status: extra.status ?? null,
  };
}

function fakeRoom(events: Fake[], opts: { token?: string | null } = {}) {
  let token = opts.token === undefined ? null : opts.token;
  const scrollbacks: number[] = [];
  let release: (() => void) | null = null;
  const em = new EventEmitter();
  const room = {
    roomId: "!r",
    getLiveTimeline: () => ({ getEvents: () => events, getPaginationToken: () => token }),
    getThreads: () => [],
    findEventById: (id: string) => events.find((e) => (e.getId as () => string)() === id),
    loadMembersIfNeeded: () => Promise.resolve(true),
    on: (n: string, f: () => void) => { em.on(n, f); }, off: (n: string, f: () => void) => { em.off(n, f); },
  };
  const client = {
    getUserId: () => ME,
    on: () => {}, off: () => {},
    // A held scrollback: resolves when the test says so.
    scrollback: (_room: unknown, n: number) => {
      scrollbacks.push(n);
      return new Promise<void>((res) => { release = () => { token = null; res(); }; });
    },
  };
  return { room, client, scrollbacks, release: () => release?.(), emit: (n: string) => em.emit(n) };
}

type Out = ReturnType<typeof useRoomTimeline>;
async function mount(client: unknown, room: unknown, box: { scrollHeight: number; clientHeight: number; scrollTop?: number }, cfg: { baseLimit?: number } = {}) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  const latest: { current: Out | null } = { current: null };
  function Host() {
    const t = useRoomTimeline(client as never, room as never, { showDeleted: false, myUserId: ME, ...(cfg.baseLimit ? { baseLimit: cfg.baseLimit } : {}) });
    latest.current = t;
    return React.createElement("div", {
      ref: (el: HTMLDivElement | null) => {
        if (el) {
          Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
          Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
          // The engine writes scrollTop to hold the bottom; the box keeps it.
          Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.scrollTop ?? 0, set: (v: number) => { box.scrollTop = v; } });
        }
        (t.scrollRef as { current: HTMLDivElement | null }).current = el;
      },
      onScroll: t.onScroll,
      "data-scroller": "",
    }, React.createElement("div", { ref: t.contentRef }, t.rendered.map((e) => React.createElement("p", { key: e.getId() }, e.getId()))));
  }
  await act(async () => { root.render(React.createElement(Host)); });
  await act(async () => { await Promise.resolve(); });
  const scroller = host.querySelector("[data-scroller]") as HTMLElement;
  const rerender = () => act(async () => { root.render(React.createElement(Host)); await Promise.resolve(); });
  return { t: () => latest.current!, scroller, rerender, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}

test("at top → scrollback once: a second scroll at the top while the page is on its way asks for nothing more", async () => {
  const events = [ev("$1", CASEY, T0), ev("$2", CASEY, T0 + 1000)];
  const f = fakeRoom(events, { token: "older" });
  // A scroller that already overflows: the auto-fill has nothing to do, only the person scrolls back.
  const box: { scrollHeight: number; clientHeight: number; scrollTop?: number } = { scrollHeight: 2000, clientHeight: 500 };
  const m = await mount(f.client, f.room, box);
  assert.equal(box.scrollTop, 2000, "opened at the bottom");
  await act(async () => { raf.flush(); });
  assert.equal(f.scrollbacks.length, 0, "an overflowing list does not page by itself");
  // The person wheels up to the top (a gesture: the engine pauses rather than holding the bottom).
  await act(async () => { m.scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -400 })); });
  assert.equal(m.t().paused, true, "a wheel up pauses");
  box.scrollTop = 0;
  await act(async () => { m.scroller.dispatchEvent(new dom.window.Event("scroll")); });
  await act(async () => { m.scroller.dispatchEvent(new dom.window.Event("scroll")); });
  assert.equal(f.scrollbacks.length, 1, "one page asked for, not two");
  assert.equal(m.t().paginating, true, "the top slot says it is loading");
  await act(async () => { f.release(); await Promise.resolve(); });
  assert.equal(m.t().paginating, false);
  assert.equal(m.t().hitStart, true, "no token left: the beginning of the conversation");
  await act(async () => { m.scroller.dispatchEvent(new dom.window.Event("scroll")); });
  assert.equal(f.scrollbacks.length, 1, "at the beginning nothing more is asked for");
  await m.unmount();
});

test("grouped/newDay flags: same sender within five minutes groups; a new sender or a new day starts a head", async () => {
  const events = [
    ev("$a1", CASEY, T0), ev("$a2", CASEY, T0 + 60_000),
    ev("$b1", ME, T0 + 120_000), ev("$b2", ME, T0 + DAY),
  ];
  const f = fakeRoom(events);
  const m = await mount(f.client, f.room, { scrollHeight: 2000, clientHeight: 500 });
  assert.deepEqual(m.t().rendered.map((e) => e.getId()), ["$a1", "$a2", "$b1", "$b2"]);
  assert.deepEqual(m.t().grouped, [false, true, false, false]);
  assert.deepEqual(m.t().newDay, [true, false, false, true]);
  await m.unmount();
});

test("reactions aggregated from the raw timeline: a reaction is no row, but its pile is on the message", async () => {
  const events = [
    ev("$1", CASEY, T0),
    ev("$r", ME, T0 + 1000, { type: "m.reaction", content: { "m.relates_to": { rel_type: "m.annotation", event_id: "$1", key: "👍" } } }),
    ev("$e", CASEY, T0 + 2000, { content: { msgtype: "m.text", body: "* fixed", "m.new_content": { msgtype: "m.text", body: "fixed" }, "m.relates_to": { rel_type: "m.replace", event_id: "$1" } } }),
  ];
  const f = fakeRoom(events);
  const m = await mount(f.client, f.room, { scrollHeight: 2000, clientHeight: 500 });
  assert.deepEqual(m.t().rendered.map((e) => e.getId()), ["$1"], "the reaction and the edit are not rows");
  const pile = m.t().reactions.get("$1") ?? [];
  assert.equal(pile.length, 1);
  assert.equal(pile[0]!.key, "👍");
  assert.equal(pile[0]!.count, 1);
  assert.equal(pile[0]!.mine, "$r", "mine: the reaction is the viewer's");
  assert.equal((m.t().edits.get("$1") as { body?: string } | undefined)?.body, "fixed", "edits read from the same raw timeline");
  await m.unmount();
});

test("one loading phase: loading until the first read and the fill are done, then ready — and it stays ready", async () => {
  const events = [ev("$1", CASEY, T0)];
  const f = fakeRoom(events, { token: "older" });
  const box = { scrollHeight: 100, clientHeight: 500 };
  const m = await mount(f.client, f.room, box);
  assert.equal(m.t().phase, "loading", "the list does not fill the panel yet: the fill pages first");
  await act(async () => { raf.flush(); });
  assert.equal(f.scrollbacks.length, 1, "the auto-fill asked for older lines");
  assert.equal(m.t().phase, "loading", "still filling");
  await act(async () => { f.release(); await Promise.resolve(); });
  assert.equal(m.t().hitStart, true);
  assert.equal(m.t().phase, "ready", "the beginning was reached: the area shows its rows");
  // A message still being decrypted arrives later: the area does not go back to the skeleton.
  events.push(ev("$2", CASEY, T0 + 1000, { type: "m.room.encrypted" }));
  await act(async () => { f.emit("Room.timeline"); await Promise.resolve(); });
  assert.deepEqual(m.t().rendered.map((e) => e.getId()), ["$1", "$2"], "the new line is in");
  assert.equal(m.t().phase, "ready", "ready latches for the room");
  await m.unmount();
});

test("a row still being decrypted holds the loading phase on open (its text would change under the eye)", async () => {
  const events = [ev("$1", CASEY, T0, { type: "m.room.encrypted" })];
  const f = fakeRoom(events);
  const m = await mount(f.client, f.room, { scrollHeight: 2000, clientHeight: 500 });
  await act(async () => { raf.flush(); });
  assert.equal(m.t().phase, "loading");
  // The decrypt lands: the SDK swaps the type in place.
  events[0] = ev("$1", CASEY, T0);
  await m.unmount();
  const again = await mount(f.client, f.room, { scrollHeight: 2000, clientHeight: 500 });
  await act(async () => { raf.flush(); });
  assert.equal(again.t().phase, "ready");
  await again.unmount();
});

// #240: the Community timeline renders 100 rows in a narrow pane and 200 in a wide one, so a
// divider dragged across the 680 px line changes `baseLimit`. That re-ran the room-open
// re-anchor and threw a reader scrolled up back to the newest line. A width change is not a
// fresh room: the reading position stays, and only a real room switch goes to the bottom.
test("#240: a width class change (base window 100 ↔ 200) while scrolled up keeps the reader where they are", async () => {
  const events = Array.from({ length: 150 }, (_, i) => ev(`$${i}`, CASEY, T0 + i * 1000));
  const f = fakeRoom(events);
  const cfg = { baseLimit: 100 };
  const box: { scrollHeight: number; clientHeight: number; scrollTop?: number } = { scrollHeight: 4000, clientHeight: 500 };
  const m = await mount(f.client, f.room, box, cfg);
  await act(async () => { raf.flush(); });
  assert.equal(box.scrollTop, 4000, "opened at the bottom");
  assert.equal(m.t().rendered.length, 100, "the narrow window");
  await act(async () => { m.scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -400 })); });
  box.scrollTop = 1800;
  await act(async () => { m.scroller.dispatchEvent(new dom.window.Event("scroll")); });
  assert.equal(m.t().paused, true, "precondition: reading");
  for (const base of [200, 100, 200]) {
    cfg.baseLimit = base;
    await m.rerender();
    assert.equal(m.t().paused, true, `base ${base}: still reading — not thrown to the newest line`);
    assert.equal(box.scrollTop, 1800, `base ${base}: the scroll position is untouched`);
  }
  // Retry: back at the bottom the window follows the width class again.
  await act(async () => { m.t().resume(); });
  cfg.baseLimit = 100;
  await m.rerender();
  assert.equal(m.t().rendered.length, 100, "at the bottom the narrow window applies");
  await m.unmount();
});

test("restart: a room switch still opens the new room at its newest line", async () => {
  const a = fakeRoom(Array.from({ length: 20 }, (_, i) => ev(`$a${i}`, CASEY, T0 + i)));
  const b = fakeRoom(Array.from({ length: 20 }, (_, i) => ev(`$b${i}`, CASEY, T0 + i)));
  (b.room as { roomId: string }).roomId = "!b";
  const box: { scrollHeight: number; clientHeight: number; scrollTop?: number } = { scrollHeight: 2000, clientHeight: 500 };
  const which = { room: a.room as unknown };
  const m = await mountSwitchable(a.client, which, box);
  await act(async () => { m.scroller.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -400 })); });
  box.scrollTop = 300;
  assert.equal(m.t().paused, true, "precondition: reading room A");
  which.room = b.room;
  await m.rerender();
  assert.equal(m.t().paused, false, "room B follows its newest line");
  assert.equal(box.scrollTop, 2000, "and opens at the bottom");
  await m.unmount();
});

/** `mount` with the room read from `which` on every render — a room switch in place. */
async function mountSwitchable(client: unknown, which: { room: unknown }, box: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(host);
  const latest: { current: Out | null } = { current: null };
  function Host() {
    const t = useRoomTimeline(client as never, which.room as never, { showDeleted: false, myUserId: ME });
    latest.current = t;
    return React.createElement("div", {
      ref: (el: HTMLDivElement | null) => {
        if (el) {
          Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
          Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
          Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.scrollTop ?? 0, set: (v: number) => { box.scrollTop = v; } });
        }
        (t.scrollRef as { current: HTMLDivElement | null }).current = el;
      },
      onScroll: t.onScroll,
      "data-scroller": "",
    });
  }
  await act(async () => { root.render(React.createElement(Host)); });
  await act(async () => { await Promise.resolve(); });
  const scroller = host.querySelector("[data-scroller]") as HTMLElement;
  const rerender = () => act(async () => { root.render(React.createElement(Host)); await Promise.resolve(); });
  return { t: () => latest.current!, scroller, rerender, unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); } };
}
