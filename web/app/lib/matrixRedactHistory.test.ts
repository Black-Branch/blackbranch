// Deleting a banned person's community messages (client polish Task 21): what is redacted, how
// far back it pages, the rate-limit retry, the 1000 cap, and that a DM is never touched.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/matrixRedactHistory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import "./testTsx.ts";

const { redactHistory, REDACT_MAX_PAGES, REDACT_MAX_TOTAL } = await import("./matrixRedactHistory.ts");

const TARGET = "@spam:site.test";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

type Ev = { id: string; sender: string; ts: number; type?: string; state?: boolean; redacted?: boolean };

function ev(e: Ev) {
  return {
    getId: () => e.id, getSender: () => e.sender, getTs: () => e.ts,
    getType: () => e.type ?? "m.room.message", getWireType: () => e.type ?? "m.room.message",
    isState: () => !!e.state, isRedacted: () => !!e.redacted,
  };
}

/** A room whose live timeline holds `loaded`; each scrollback prepends the next page of `older`. */
function fakeRoom(roomId: string, loaded: Ev[], older: Ev[][] = [], opts: { dmInviter?: string } = {}) {
  const events = loaded.map(ev);
  const pages = older.map((p) => p.map(ev));
  return {
    roomId,
    getDMInviter: () => opts.dmInviter,
    getLiveTimeline: () => ({ getEvents: () => events }),
    nextPage() { const p = pages.shift(); if (p) events.unshift(...p); },
  };
}

function fakeClient(rooms: ReturnType<typeof fakeRoom>[], opts: { direct?: Record<string, string[]>; redact?: (roomId: string, id: string, n: number) => Promise<unknown> } = {}) {
  const redactions: { roomId: string; id: string; reason?: string }[] = [];
  let scrollbacks = 0;
  let calls = 0;
  const client = {
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: (type: string) => (type === "m.direct" && opts.direct ? { getContent: () => opts.direct } : undefined),
    scrollback: async (room: ReturnType<typeof fakeRoom>) => { scrollbacks++; room.nextPage(); return room; },
    redactEvent: async (roomId: string, id: string, _txn?: string, o?: { reason?: string }) => {
      calls++;
      if (opts.redact) await opts.redact(roomId, id, calls);
      redactions.push({ roomId, id, reason: o?.reason });
      return { event_id: `$r${calls}` };
    },
  };
  return { client, redactions, scrollbacks: () => scrollbacks, calls: () => calls };
}

const noSleep = async () => {};
const scope = (...ids: string[]) => ids.map((roomId) => ({ roomId, name: roomId }));

test("only the target's events newer than since are redacted, with the reason", async () => {
  const room = fakeRoom("!general:site.test", [
    { id: "$old", sender: TARGET, ts: NOW - 2 * HOUR },
    { id: "$other", sender: "@ok:site.test", ts: NOW - 10_000 },
    { id: "$a", sender: TARGET, ts: NOW - 30_000 },
    { id: "$member", sender: TARGET, ts: NOW - 20_000, type: "m.room.member", state: true },
    { id: "$gone", sender: TARGET, ts: NOW - 15_000, redacted: true },
    { id: "$enc", sender: TARGET, ts: NOW - 10_000, type: "m.room.encrypted" },
    { id: "~local", sender: TARGET, ts: NOW - 5_000 },
  ]);
  const { client, redactions } = fakeClient([room]);
  const progress: [number, number][] = [];
  const out = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, "spam", (d, t) => progress.push([d, t]), noSleep);
  // An encrypted line needs no decryption: its sender is visible. State events, lines already
  // removed, other people's lines and lines older than the window stay.
  assert.deepEqual(redactions, [
    { roomId: "!general:site.test", id: "$a", reason: "spam" },
    { roomId: "!general:site.test", id: "$enc", reason: "spam" },
  ]);
  assert.deepEqual(out, { redacted: 2, failed: 0, rooms: 1 });
  assert.deepEqual(progress.at(-1), [2, 2]);
  assert.deepEqual(progress[0], [0, 2]);
});

test("pages back until an event is older than since", async () => {
  const room = fakeRoom("!general:site.test",
    [{ id: "$new", sender: TARGET, ts: NOW - 1000 }],
    [[{ id: "$mid", sender: TARGET, ts: NOW - 20 * 60_000 }], [{ id: "$older", sender: TARGET, ts: NOW - 3 * HOUR }], [{ id: "$never", sender: TARGET, ts: NOW - 9 * HOUR }]]);
  const { client, redactions, scrollbacks } = fakeClient([room]);
  const out = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.deepEqual(redactions.map((r) => r.id).sort(), ["$mid", "$new"]);
  assert.equal(scrollbacks(), 2, "stops paging once an event older than the window is loaded");
  assert.equal(out.redacted, 2);
});

test("stops at the page bound", async () => {
  // A room busier than the bound: every page is inside the window, and paging still stops.
  const pages = Array.from({ length: REDACT_MAX_PAGES + 5 }, (_, i) => [{ id: `$p${i}`, sender: "@ok:site.test", ts: NOW - (i + 1) * 1000 }]);
  const room = fakeRoom("!general:site.test", [{ id: "$a", sender: TARGET, ts: NOW - 500 }], pages);
  const { client, scrollbacks } = fakeClient([room]);
  await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - 7 * 24 * HOUR, undefined, undefined, noSleep);
  assert.equal(scrollbacks(), REDACT_MAX_PAGES);
});

test("stops paging at the start of the room (a page that adds nothing)", async () => {
  const room = fakeRoom("!general:site.test", [{ id: "$a", sender: TARGET, ts: NOW - 500 }]);
  const { client, scrollbacks } = fakeClient([room]);
  await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.equal(scrollbacks(), 1);
});

test("a rate limit is retried once", async () => {
  const room = fakeRoom("!general:site.test", [
    { id: "$a", sender: TARGET, ts: NOW - 500 }, { id: "$b", sender: TARGET, ts: NOW - 400 },
  ]);
  const limited = Object.assign(new Error("slow down"), { errcode: "M_LIMIT_EXCEEDED", data: { retry_after_ms: 5 } });
  const slept: number[] = [];
  const { client, redactions, calls } = fakeClient([room], {
    // $a is limited once then goes through; $b is limited twice and is reported, not thrown.
    redact: async (_r, id, n) => { if ((id === "$a" && n === 1) || id === "$b") throw limited; },
  });
  const out = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, async (ms) => { slept.push(ms); });
  assert.deepEqual(redactions.map((r) => r.id), ["$a"]);
  assert.equal(calls(), 4, "each line is tried at most twice");
  assert.deepEqual(slept, [5, 5]);
  assert.deepEqual(out, { redacted: 1, failed: 1, rooms: 1 });
});

test("the 1000 cap reports the remainder as failed", async () => {
  const many = Array.from({ length: REDACT_MAX_TOTAL + 7 }, (_, i) => ({ id: `$m${i}`, sender: TARGET, ts: NOW - 1000 + i }));
  const room = fakeRoom("!general:site.test", many);
  const { client, calls } = fakeClient([room]);
  const out = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.equal(calls(), REDACT_MAX_TOTAL);
  assert.deepEqual(out, { redacted: REDACT_MAX_TOTAL, failed: 7, rooms: 1 });
});

test("a DM room in scope is skipped", async () => {
  const general = fakeRoom("!general:site.test", [{ id: "$a", sender: TARGET, ts: NOW - 500 }]);
  const filed = fakeRoom("!dm:site.test", [{ id: "$dm", sender: TARGET, ts: NOW - 500 }]);
  const invite = fakeRoom("!dm2:site.test", [{ id: "$dm2", sender: TARGET, ts: NOW - 500 }], [], { dmInviter: TARGET });
  const { client, redactions, scrollbacks } = fakeClient([general, filed, invite], { direct: { [TARGET]: ["!dm:site.test"] } });
  const out = await redactHistory(client as never, scope("!general:site.test", "!dm:site.test", "!dm2:site.test", "!unknown:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.deepEqual(redactions.map((r) => r.id), ["$a"]);
  assert.equal(scrollbacks(), 1, "a DM is not even read");
  assert.deepEqual(out, { redacted: 1, failed: 0, rooms: 1 });
});

test("retry: a second run removes only what the first left (a failed line), nothing twice", async () => {
  const limited = Object.assign(new Error("slow down"), { errcode: "M_LIMIT_EXCEEDED", data: { retry_after_ms: 1 } });
  const lines: Ev[] = [{ id: "$a", sender: TARGET, ts: NOW - 500 }, { id: "$b", sender: TARGET, ts: NOW - 400 }];
  const room = fakeRoom("!general:site.test", lines);
  let fail = true;
  const { client, redactions } = fakeClient([room], { redact: async (_r, id) => { if (fail && id === "$b") throw limited; } });
  // The fake marks a redacted line the way the SDK does once the redaction comes down the sync.
  const first = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.deepEqual(first, { redacted: 1, failed: 1, rooms: 1 });
  lines[0]!.redacted = true;
  room.getLiveTimeline().getEvents().splice(0, 2, ...lines.map(ev));
  fail = false;
  const second = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.deepEqual(second, { redacted: 1, failed: 0, rooms: 1 });
  assert.deepEqual(redactions.map((r) => r.id), ["$a", "$b"]);
});

test("restart: a fresh client (nothing loaded yet) pages the history in from the server and finds the lines", async () => {
  // After a reload the live timeline starts empty; the lines arrive only through scrollback.
  const room = fakeRoom("!general:site.test", [], [[{ id: "$a", sender: TARGET, ts: NOW - 500 }, { id: "$b", sender: TARGET, ts: NOW - 400 }], [{ id: "$old", sender: TARGET, ts: NOW - 5 * HOUR }]]);
  const { client, redactions } = fakeClient([room]);
  const out = await redactHistory(client as never, scope("!general:site.test"), TARGET, NOW - HOUR, undefined, undefined, noSleep);
  assert.deepEqual(redactions.map((r) => r.id), ["$a", "$b"]);
  assert.equal(out.redacted, 2);
});
