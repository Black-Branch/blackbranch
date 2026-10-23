// The shared chat socket notices a connection that has gone silent without closing.
//
// The defect: on bad reception (a phone between cells, a laptop waking) a WebSocket can stop
// delivering frames without ever firing `close` — the TCP connection is dead but nobody has said
// so. The hook reconnected only on `onclose`, so chat froze until a reload. stream-api broadcasts
// a timerState frame at least every 60 s to every client (timer.js heartbeat), so a socket that
// has heard nothing for STALE_MS is dead: close it, reconnect with backoff, and never let the old
// socket's late frames through (the new socket's `history` is the replay).
//
// Driven, not scanned: a fake WebSocket and node's mock timers run the real module.
//
// Run: node --test app/lib/chatSocketLiveness.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  closeCalls = 0;
  url: string;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  /** The server accepted the upgrade. */
  open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
  /** A frame arrives. */
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  /** A clean close the browser reports. */
  drop() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
  /** On a dead connection the close handshake never completes: no `close` event. */
  close() { this.closeCalls += 1; this.readyState = FakeWS.CLOSING; }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

const { subscribe, STALE_MS, CHECK_MS } = await import("./useChatSocket.ts");
const { socketHealth } = await import("./socketHealth.ts");

type Log = { events: string[]; opens: number; closes: number };
function attach(): Log & { off: () => void } {
  const log: Log = { events: [], opens: 0, closes: 0 };
  const off = subscribe({
    onEvent: (d) => log.events.push(String((d as { type?: string }).type)),
    onOpen: () => { log.opens += 1; },
    onClose: () => { log.closes += 1; },
  });
  return Object.assign(log, { off });
}
const latest = () => FakeWS.all[FakeWS.all.length - 1]!;
/** Real time passing, a second at a time. One big `tick` jumps the clock to its end before any
 *  callback runs, which is what a FROZEN tab looks like, not a running one. */
function advance(t: { mock: { timers: { tick: (ms: number) => void } } }, ms: number) {
  for (let left = ms; left > 0; left -= 1_000) t.mock.timers.tick(Math.min(1_000, left));
}

test.beforeEach((t) => {
  if (!("mock" in t)) return;
  FakeWS.all = [];
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
});

test("a socket that stops delivering without closing is replaced", (t) => {
  const s = attach();
  t.after(() => s.off());
  const first = latest();
  first.open();
  first.frame({ type: "hello" });
  advance(t, STALE_MS + CHECK_MS);
  assert.equal(first.closeCalls, 1, "the silent socket is closed");
  assert.equal(s.closes, 1, "subscribers hear the drop (the reconnecting badge)");
  t.mock.timers.tick(1_000);
  assert.equal(FakeWS.all.length, 2, "a new connection is opened after the backoff");
  latest().open();
  assert.equal(s.opens, 2);
});

test("original path: a socket hearing the server's heartbeat is never touched", (t) => {
  const s = attach();
  t.after(() => s.off());
  const ws = latest();
  ws.open();
  ws.frame({ type: "hello" });
  for (let i = 0; i < 20; i++) { advance(t, 60_000); ws.frame({ type: "timerState" }); }
  assert.equal(FakeWS.all.length, 1, "no reconnect while frames arrive at the heartbeat's slowest cadence");
  assert.equal(ws.closeCalls, 0);
  // A clean close still reconnects as before.
  ws.drop();
  t.mock.timers.tick(1_000);
  assert.equal(FakeWS.all.length, 2);
});

test("the old socket's late frames never reach subscribers (no duplicated history)", (t) => {
  const s = attach();
  t.after(() => s.off());
  const old = latest();
  old.open();
  old.frame({ type: "hello" });
  advance(t, STALE_MS + CHECK_MS + 1_000);
  const fresh = latest();
  assert.notEqual(fresh, old);
  fresh.open();
  fresh.frame({ type: "history" });
  old.frame({ type: "history" }); // the dead connection wakes up and flushes
  old.frame({ type: "message" });
  old.drop();                      // and its late close must not schedule a second reconnect
  assert.deepEqual(s.events.filter((e) => e === "history"), ["history"], "one history, from the new socket");
  assert.ok(!s.events.includes("message"), "nothing from the replaced socket");
  advance(t, 60_000);
  assert.equal(FakeWS.all.length, 2, "the replaced socket's close did not start another connection");
});

test("retry: a server that accepts and then says nothing backs off instead of storming", (t) => {
  const s = attach();
  t.after(() => s.off());
  const starts: number[] = [];
  let seen = 0;
  for (let i = 0; i < 20_000 && FakeWS.all.length < 6; i++) {
    if (FakeWS.all.length > seen) { seen = FakeWS.all.length; starts.push(Date.now()); latest().open(); }
    t.mock.timers.tick(250);
  }
  assert.ok(starts.length >= 4, "it kept retrying");
  // Each gap = time to notice silence + a backoff that grows, because an open with no frame is not
  // proof of life.
  const gaps = starts.slice(1).map((s2, i) => s2 - starts[i]!);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! > gaps[i - 1]!, `gap ${i} grew: ${gaps.join(", ")}`);
});

test("retry: a socket that opens and closes at once backs off too (open alone is not proof of life)", (t) => {
  const s = attach();
  t.after(() => s.off());
  const starts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const ws = latest();
    starts.push(Date.now());
    ws.open();
    ws.drop();
    const before = FakeWS.all.length;
    while (FakeWS.all.length === before) t.mock.timers.tick(250);
  }
  const gaps = starts.slice(1).map((s2, i) => s2 - starts[i]!);
  assert.deepEqual(gaps, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("a frame resets the backoff: the next drop reconnects after a second again", (t) => {
  const s = attach();
  t.after(() => s.off());
  let ws = latest();
  ws.open(); ws.drop();
  t.mock.timers.tick(1_000);
  ws = latest(); ws.open(); ws.drop();
  t.mock.timers.tick(2_000);
  ws = latest(); ws.open(); ws.frame({ type: "hello" }); ws.drop();
  const before = FakeWS.all.length;
  t.mock.timers.tick(1_000);
  assert.equal(FakeWS.all.length, before + 1, "healthy again → the short delay");
});

test("a tab that was frozen is given one period to drain before its socket is judged", (t) => {
  const s = attach();
  t.after(() => s.off());
  const ws = latest();
  ws.open();
  ws.frame({ type: "hello" });
  // The page was frozen for ten minutes: timers did not run, then everything runs at once.
  t.mock.timers.setTime(Date.now() + 10 * 60_000);
  t.mock.timers.tick(CHECK_MS);
  assert.equal(ws.closeCalls, 0, "frozen is not dead: the queued frames get their chance");
  ws.frame({ type: "timerState" });
  t.mock.timers.tick(CHECK_MS);
  assert.equal(ws.closeCalls, 0);
});

test("restart: the last subscriber leaving stops the watchdog; a remount starts a fresh one", (t) => {
  const a = attach();
  const ws = latest();
  ws.open();
  ws.frame({ type: "hello" });
  a.off();
  assert.equal(ws.closeCalls, 1, "teardown closes the socket");
  advance(t, 10 * STALE_MS);
  assert.equal(FakeWS.all.length, 1, "nothing reconnects for a page nobody holds");
  const b = attach();
  t.after(() => b.off());
  assert.equal(FakeWS.all.length, 2, "the remount opens its own connection");
  const again = latest();
  again.open();
  again.frame({ type: "hello" });
  advance(t, STALE_MS + CHECK_MS);
  assert.equal(again.closeCalls, 1, "and its own watchdog runs");
});

test("the device-health report counts a silent-socket replacement as a reconnect", (t) => {
  const s = attach();
  t.after(() => s.off());
  const before = socketHealth.reconnects;
  latest().open();
  latest().frame({ type: "hello" });
  advance(t, STALE_MS + CHECK_MS);
  assert.equal(socketHealth.reconnects, before + 1);
});

test("STALE_MS outlasts the server's slowest guaranteed frame (timer heartbeat: 15 s ticks, every 4th always sent)", () => {
  const timer = readFileSync(new URL("../../../stream-api/timer.js", import.meta.url), "utf8");
  const tick = Number(/function startHeartbeat\(ms = (\d+)\)/.exec(timer)?.[1]);
  const every = Number(/const HB_RESYNC_EVERY = (\d+);/.exec(timer)?.[1]);
  assert.ok(tick > 0 && every > 0, "the heartbeat's constants moved — this test read nothing");
  assert.ok(STALE_MS >= tick * every * 1.5, `STALE_MS ${STALE_MS} must clear the ${tick * every} ms worst gap with room`);
  const index = readFileSync(new URL("../../../stream-api/index.js", import.meta.url), "utf8");
  assert.match(index, /\ntimer\.startHeartbeat\(\);/, "the heartbeat is started unconditionally");
});
