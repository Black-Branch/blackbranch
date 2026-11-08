// A message waiting for its key says so, and fixes itself when the key arrives: the copy map and
// the restore schedule, RUN against a fake client and room (no source scan).
// Run: node --test app/lib/keyWait.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { keyWaitCopy, lockCopy, startKeyWait } from "./keyWait.ts";
import "./testTsx.ts";
const { runSignOutHooks } = await import("./plugins/session.ts");

const WAITING = "🔒 Waiting for this message's key…";
const SETTLED = "🔒 Can't read this message on this device — the sender's device didn't share its key";
const BEFORE = "🔒 sent before you signed in on this device";

type Fake = { id: string; reason: string | null; type?: string };
function fakeEvent(f: Fake): MatrixEvent {
  return {
    getId: () => f.id,
    getRoomId: () => "!r:site.test",
    getType: () => f.type ?? "m.room.message",
    isEncrypted: () => true,
    isDecryptionFailure: () => f.reason !== null,
    get decryptionFailureReason() { return f.reason; },
  } as unknown as MatrixEvent;
}

function setup(events: Fake[]) {
  const calls: number[] = [];
  const client = Object.assign(new EventEmitter(), {
    getCrypto: () => ({ restoreKeyBackup: async () => { calls.push(Date.now()); return { total: 0, imported: 0 }; } }),
  });
  const room = Object.assign(new EventEmitter(), {
    roomId: "!r:site.test",
    getLiveTimeline: () => ({ getEvents: () => events.map(fakeEvent) }),
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  const settled: boolean[] = [];
  // Another view of the same room on the same client (the room re-opened, or the Community
  // timeline and the DM window at once).
  const mount = (into: boolean[] = []) => startKeyWait(client as unknown as MatrixClient, room as unknown as Room, (s) => into.push(s), doc);
  const stop = mount(settled);
  const visible = () => { doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange")); };
  return { calls, client, room, events, settled, stop, visible, mount };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
// A second at a time, settling promises between: a restore takes real time to answer, so two
// timers must not fire in one synchronous jump while the first is still in flight.
async function tick(t: { mock: { timers: { tick: (ms: number) => void } } }, ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    t.mock.timers.tick(Math.min(1_000, left));
    await flush();
  }
}

test("the code → copy map", () => {
  for (const code of ["MEGOLM_UNKNOWN_INBOUND_SESSION_ID", "OLM_UNKNOWN_MESSAGE_INDEX", "HISTORICAL_MESSAGE_WORKING_BACKUP"]) {
    assert.equal(keyWaitCopy(code, false), WAITING, code);
    assert.equal(keyWaitCopy(code, true), SETTLED, `${code} after the retries are spent`);
  }
  // The no-backup cases keep today's copy, settled or not: no retry can fetch what no backup holds.
  for (const code of ["HISTORICAL_MESSAGE_NO_KEY_BACKUP", "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED"]) {
    assert.equal(keyWaitCopy(code, false), BEFORE, code);
    assert.equal(keyWaitCopy(code, true), BEFORE, code);
  }
  assert.equal(keyWaitCopy("HISTORICAL_MESSAGE_USER_NOT_JOINED", false), "🔒 sent before you joined");
  assert.equal(keyWaitCopy("MEGOLM_KEY_WITHHELD", false), "🔒 waiting for the sender to share the key");
  assert.equal(keyWaitCopy(undefined, false), "🔒 can’t decrypt this message");
  // The row's copy: a readable event has none; one still being decrypted waits; a failure maps.
  assert.equal(lockCopy(fakeEvent({ id: "$a", reason: null }), false), undefined);
  assert.equal(lockCopy(fakeEvent({ id: "$p", reason: null, type: "m.room.encrypted" }), false), WAITING);
  assert.equal(lockCopy(fakeEvent({ id: "$f", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }), true), SETTLED);
});

test("restoreKeyBackup at 10 s, 30 s, 2 min; a visible tab never adds one within a minute of the last", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 9_999);
  assert.deepEqual(s.calls, [], "nothing before 10 s");
  await tick(t, 1);
  assert.deepEqual(s.calls, [10_000]);
  // Coming back to the tab 5 s later asks for nothing: the last call was under a minute ago.
  await tick(t, 5_000);
  s.visible();
  await flush();
  assert.deepEqual(s.calls, [10_000]);
  await tick(t, 15_000);
  assert.deepEqual(s.calls, [10_000, 30_000]);
  s.visible();
  await flush();
  assert.deepEqual(s.calls, [10_000, 30_000], "a visibility change inside the minute is dropped");
  await tick(t, 90_000);
  assert.deepEqual(s.calls, [10_000, 30_000, 120_000]);
  await tick(t, 10 * 60_000);
  assert.deepEqual(s.calls, [10_000, 30_000, 120_000], "three scheduled tries, then only a visible tab asks again");
  s.stop();
});

test("visibilitychange → visible triggers one call", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "OLM_UNKNOWN_MESSAGE_INDEX" }]);
  await tick(t, 3_000);
  s.visible();
  await flush();
  assert.deepEqual(s.calls, [3_000], "one call at once");
  s.visible();
  await flush();
  assert.deepEqual(s.calls, [3_000], "not a second one");
  s.stop();
});

test("a hidden tab's visibilitychange asks for nothing, and a room with no waiting rows never asks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$ok", reason: null }, { id: "$old", reason: "HISTORICAL_MESSAGE_NO_KEY_BACKUP" }]);
  s.visible();
  await tick(t, 5 * 60_000);
  assert.deepEqual(s.calls, []);
  s.stop();
});

test("a Decrypted on the last waiting row stops the schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 10_000);
  assert.equal(s.calls.length, 1);
  // The key arrived (the first restore imported it): the SDK decrypts the event in place.
  s.events[0]!.reason = null;
  s.client.emit("Event.decrypted", fakeEvent(s.events[0]!));
  await tick(t, 5 * 60_000);
  s.visible();
  await flush();
  assert.equal(s.calls.length, 1, "no further restore once nothing waits");
  assert.ok(!s.settled.includes(true), "never settled: the row resolved");
  s.stop();
});

test("after the last retry the copy settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 30_000);
  assert.ok(!s.settled.includes(true), "still waiting after two tries");
  await tick(t, 90_000);
  assert.equal(s.settled.at(-1), true, "settled after the 2-minute try");
  assert.equal(keyWaitCopy("MEGOLM_UNKNOWN_INBOUND_SESSION_ID", s.settled.at(-1)!), SETTLED);
  // A NEW message waiting for its key is waited for afresh: the copy goes back to waiting.
  s.events.push({ id: "$new", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" });
  s.room.emit("Room.timeline");
  await flush();
  assert.equal(s.settled.at(-1), false);
  await tick(t, 10_000);
  assert.equal(s.calls.length, 3, "its 10 s try falls inside the 20 s floor after the last restore");
  await tick(t, 20_000);
  assert.equal(s.calls.length, 4, "its 30 s try");
  s.stop();
});

test("20 fresh ids in a burst → at most one restore per gap and the cap holds", async (t) => {
  // Anyone in a room can send lines this device cannot read; each must not buy a full backup download.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w0", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  // 12 s apart: each new id would otherwise restart the schedule just after its 10 s try fired.
  for (let i = 1; i <= 20; i++) {
    await tick(t, 12_000);
    s.events.push({ id: `$w${i}`, reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" });
    s.room.emit("Room.timeline");
    await flush();
  }
  await tick(t, 10 * 60_000);
  for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i]! - s.calls[i - 1]! >= 20_000, `restores ${s.calls[i - 1]} and ${s.calls[i]} are under 20 s apart`);
  assert.ok(s.calls.length <= 9, `three schedules of three tries at most, got ${s.calls.length}`);
  const last = s.calls.at(-1)!;
  await tick(t, 10 * 60_000);
  assert.equal(s.calls.at(-1), last, "the cap holds: nothing more is scheduled");
  assert.equal(s.settled.at(-1), false, "past the cap a new waiting row still says it is waiting — it only schedules no restore");
  s.stop();
});

test("a key arriving cancels the schedule, and lets the next waiting row be waited for", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }, { id: "$v", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 10_000);
  assert.equal(s.calls.length, 1);
  // Both resolve: the schedule is cancelled.
  for (const e of s.events) e.reason = null;
  s.client.emit("Event.decrypted", fakeEvent(s.events[0]!));
  await tick(t, 5 * 60_000);
  assert.equal(s.calls.length, 1, "cancelled");
  s.events.push({ id: "$n", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" });
  s.room.emit("Room.timeline");
  await tick(t, 10_000);
  assert.equal(s.calls.length, 2, "a new line waits afresh");
  s.stop();
});

test("restart: stop() cancels every timer and listener; a remount waits again but does not reset the count or the gap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const a = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 10_000);
  assert.deepEqual(a.calls, [10_000]);
  a.stop();
  await tick(t, 5 * 60_000);
  a.visible();
  await flush();
  assert.deepEqual(a.calls, [10_000], "a stopped wait asks for nothing");
  assert.equal(a.client.listenerCount("Event.decrypted"), 0);
  assert.equal(a.room.listenerCount("Room.timeline"), 0);
  // The same room opened again on the same client: its second schedule (of three), not a fresh count.
  let stop = a.mount();
  await tick(t, 10_000);
  assert.equal(a.calls.length, 2, "the re-opened room tries again");
  stop();
  // Opened again at once: its 10 s try falls inside the shared 20 s floor, its 30 s one runs.
  stop = a.mount();
  await tick(t, 30_000);
  assert.equal(a.calls.length, 3);
  stop();
  stop = a.mount();
  await tick(t, 10 * 60_000);
  assert.equal(a.calls.length, 3, "the fourth opening is past the cap: no schedule");
  stop();
});

test("10 minutes of re-opening a room every 11 s → at most 9 restores, never two within 20 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  let stop = s.stop;
  for (let at = 0; at < 10 * 60_000; at += 11_000) {
    await tick(t, 11_000);
    stop();
    stop = s.mount();
  }
  stop();
  assert.ok(s.calls.length <= 9, `got ${s.calls.length} restores`);
  for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i]! - s.calls[i - 1]! >= 20_000);
});

test("two mounts of one room (the timeline and the DM window) → one restore, one settled state", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  const second: boolean[] = [];
  const stop2 = s.mount(second);
  await tick(t, 10_000);
  assert.deepEqual(s.calls, [10_000], "the second view joined the first's schedule");
  assert.equal(s.client.listenerCount("Event.decrypted"), 1, "one subscription for the room");
  await tick(t, 120_000);
  assert.equal(s.settled.at(-1), true);
  assert.equal(second.at(-1), true, "both views hear the settle");
  // The first view closes; the second keeps the room's wait alive.
  s.stop();
  assert.equal(s.client.listenerCount("Event.decrypted"), 1);
  stop2();
  assert.equal(s.client.listenerCount("Event.decrypted"), 0);
});

test("sign-out forgets the counts: the next person's first opening waits from the start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const s = setup([{ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" }]);
  await tick(t, 130_000);
  s.stop();
  for (let i = 0; i < 3; i++) { const stop = s.mount(); await tick(t, 130_000); stop(); }
  const before = s.calls.length;
  let stop = s.mount();
  await tick(t, 130_000);
  stop();
  assert.equal(s.calls.length, before, "settled for this client: re-opening asks for nothing");
  runSignOutHooks();
  stop = s.mount();
  await tick(t, 10_000);
  assert.equal(s.calls.length, before + 1, "after sign-out the wait starts afresh");
  stop();
});

test("retry: a restore that throws (no backup key on this device) is swallowed and the schedule goes on", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let tries = 0;
  const client = Object.assign(new EventEmitter(), {
    getCrypto: () => ({ restoreKeyBackup: async () => { tries++; throw new Error("No decryption key found in crypto store"); } }),
  });
  const room = Object.assign(new EventEmitter(), {
    roomId: "!r:site.test",
    getLiveTimeline: () => ({ getEvents: () => [fakeEvent({ id: "$w", reason: "MEGOLM_UNKNOWN_INBOUND_SESSION_ID" })] }),
  });
  const settled: boolean[] = [];
  const stop = startKeyWait(client as unknown as MatrixClient, room as unknown as Room, (s) => settled.push(s), Object.assign(new EventTarget(), { visibilityState: "hidden" }));
  await tick(t, 120_000);
  assert.equal(tries, 3);
  assert.equal(settled.at(-1), true);
  stop();
});
