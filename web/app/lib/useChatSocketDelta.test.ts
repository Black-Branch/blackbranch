// A reconnect asks stream-api only for what changed while it was away.
//
// The defect: every reconnect (a phone between cells, a tab waking) was sent the whole 200-line
// `history` frame again — ~98 KB measured on the throwaway pair — although the page already held
// all but the last few lines. stream-api now stamps every buffered line with a `seq` and names
// its boot with an `epoch` (ws-hub.js; ws-history-delta.test.js); the page remembers the newest
// position it has seen, resumes with `?since=<seq>&epoch=<epoch>`, and merges the answer — a
// `history` frame with `delta: true` — by id, a deleted line arriving as its emptied envelope.
//
// Driven, not scanned: a fake WebSocket runs the real shared connection, and the real
// useChatMessages hook is mounted in jsdom for the merge.
//
// Run: node --test app/lib/useChatSocketDelta.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mountHook } from "./testDom.ts";
import "./testTsx.ts";
import type { ChatMsg } from "./chatMsg.ts";

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
  url: string;
  constructor(url: string) { this.url = String(url); FakeWS.all.push(this); }
  open() { this.readyState = FakeWS.OPEN; this.onopen?.(); }
  frame(f: object) { this.onmessage?.({ data: JSON.stringify(f) }); }
  drop() { this.readyState = FakeWS.CLOSED; this.onclose?.(); }
  close() { this.readyState = FakeWS.CLOSING; }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

const { subscribe } = await import("./useChatSocket.ts");
const { useChatMessages } = await import("./useChatMessages.ts");
const { applyCardFrame } = await import("./userLiveFrames.ts");

const latest = () => FakeWS.all[FakeWS.all.length - 1]!;
const resumeOf = (ws: FakeWS) => {
  const q = ws.url.indexOf("?");
  const p = new URLSearchParams(q === -1 ? "" : ws.url.slice(q + 1));
  return { since: p.get("since"), epoch: p.get("epoch") };
};
/** The reconnect backoff starts at 1 s. */
const backoff = () => new Promise((r) => setTimeout(r, 1_100));

function line(id: number, extra: Partial<ChatMsg> = {}): ChatMsg {
  return { type: "message", platform: "twitch", id, username: "casey", message: `line ${id}`, ts: 1_000 + id, ...extra } as ChatMsg;
}

test("reconnect URL carries since and epoch — the newest position the page saw", async () => {
  FakeWS.all = [];
  const off = subscribe({ onEvent: () => {} });
  try {
    const first = latest();
    assert.deepEqual(resumeOf(first), { since: null, epoch: null }, "a first connect asks for the full frame");
    first.open();
    first.frame({ type: "hello", internal: false });
    first.frame({ type: "history", epoch: "ab12cd34ef56", seq: 7, messages: [line(1, { seq: 7 } as Partial<ChatMsg>)] });
    first.frame({ ...line(2), seq: 9 });
    first.frame({ type: "timerState" }); // a frame with no seq leaves the position alone
    first.drop();
    await backoff();
    assert.equal(FakeWS.all.length, 2);
    assert.deepEqual(resumeOf(latest()), { since: "9", epoch: "ab12cd34ef56" });
  } finally { off(); }
});

test("retry: a reconnect that fails before any frame resumes from the same position", async () => {
  FakeWS.all = [];
  const off = subscribe({ onEvent: () => {} });
  try {
    latest().open();
    latest().frame({ type: "history", epoch: "0123abcd", seq: 4, messages: [] });
    latest().drop();
    await backoff();
    latest().drop(); // refused: closed before a single frame
    await new Promise((r) => setTimeout(r, 2_100)); // the backoff doubled
    assert.equal(FakeWS.all.length, 3);
    assert.deepEqual(resumeOf(latest()), { since: "4", epoch: "0123abcd" });
  } finally { off(); }
});

test("restart: a full frame from a new boot replaces the position, even with a lower seq", async () => {
  FakeWS.all = [];
  const off = subscribe({ onEvent: () => {} });
  try {
    latest().open();
    latest().frame({ type: "history", epoch: "aaaa1111", seq: 500, messages: [] });
    latest().drop();
    await backoff();
    // stream-api restarted: the resume is not honoured, the full frame of the new boot arrives.
    latest().open();
    latest().frame({ type: "history", epoch: "bbbb2222", seq: 3, messages: [] });
    latest().drop();
    await backoff();
    assert.deepEqual(resumeOf(latest()), { since: "3", epoch: "bbbb2222" });
  } finally { off(); }
});

test("the last subscriber leaving forgets the position: the next connection asks for everything", async () => {
  FakeWS.all = [];
  const off = subscribe({ onEvent: () => {} });
  latest().open();
  latest().frame({ type: "history", epoch: "cccc3333", seq: 12, messages: [] });
  off();
  const again = subscribe({ onEvent: () => {} });
  try {
    assert.deepEqual(resumeOf(latest()), { since: null, epoch: null });
  } finally { again(); }
});

test("a delta merges by id and applies a deletion envelope (the real chat hook)", async () => {
  FakeWS.all = [];
  const seed = [line(1), line(2), line(3)];
  const chat = await mountHook(() => useChatMessages({ isMod: false, initialMessages: seed }));
  try {
    const ids = () => chat.current.messages.map((m) => m.id);
    assert.deepEqual(ids(), [1, 2, 3]);
    await chat.act(() => {
      latest().open();
      latest().frame({ type: "history", epoch: "dddd4444", seq: 3, messages: seed.map((m, i) => ({ ...m, seq: i + 1 })) });
      latest().drop();
    });
    await backoff();
    assert.deepEqual(resumeOf(latest()), { since: "3", epoch: "dddd4444" });
    await chat.act(() => {
      latest().open();
      latest().frame({
        type: "history", delta: true, epoch: "dddd4444", seq: 5,
        messages: [
          { ...line(2), message: "", deleted: true, seq: 4 }, // deleted while the page was away
          { ...line(4), seq: 5 },                             // said while the page was away
        ],
      });
    });
    assert.deepEqual(ids(), [1, 3, 4], "the deleted line is gone, the new one is in, nothing doubled");
    assert.ok(!chat.current.messages.some((m) => m.message === ""), "no emptied envelope is shown as a line");
  } finally { await chat.unmount(); }
});

test("the popped-out user card merges a delta instead of replacing its lines with it", () => {
  const view = { mine: (m: ChatMsg) => m.username === "casey", showDeleted: false };
  const prev = [line(1), line(2), line(3)];
  const next = applyCardFrame(prev, {
    type: "history", delta: true, epoch: "eeee5555", seq: 9,
    messages: [{ ...line(2), message: "", deleted: true }, line(4), { ...line(5), username: "robin" }],
  } as never, view);
  assert.deepEqual(next.map((m) => m.id), [1, 3, 4]);
  // A full frame still replaces, as before.
  const full = applyCardFrame(prev, { type: "history", messages: [line(7)] } as never, view);
  assert.deepEqual(full.map((m) => m.id), [7]);
});
