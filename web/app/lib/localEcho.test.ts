// The local echo's send state, as the SDK spells it. localEcho.ts is type-only
// on the SDK (matrixDm.ts's seam), so it writes the SDK's strings; this pins
// each one against the real EventStatus enum, and the mapping a row reads.
// Run: env -u DATABASE_URL systemd-run --user --scope -p MemoryMax=8G npx tsx --test app/lib/localEcho.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventStatus } from "matrix-js-sdk";
import { echoState, retryEcho, dropEcho, localEchoOf, CANCELLABLE_STATES } from "./localEcho.ts";
import { stripComments } from "./testSource.ts";

const ev = (status: string | null) => ({ status }) as never;

test("the mapping: not_sent and cancelled are failed; queued, sending, encrypting are sending; null and sent are sent", () => {
  const table: Array<[string | null, string]> = [
    ["not_sent", "failed"],
    ["cancelled", "failed"],
    ["queued", "sending"],
    ["sending", "sending"],
    ["encrypting", "sending"],
    [null, "sent"],
    ["sent", "sent"],
  ];
  for (const [status, want] of table) assert.equal(echoState(ev(status)), want, `status ${status}`);
});

test("every string localEcho.ts writes is the SDK's own EventStatus member", () => {
  assert.equal(EventStatus.NOT_SENT, "not_sent");
  assert.equal(EventStatus.CANCELLED, "cancelled");
  assert.equal(EventStatus.QUEUED, "queued");
  assert.equal(EventStatus.SENDING, "sending");
  assert.equal(EventStatus.ENCRYPTING, "encrypting");
  assert.equal(EventStatus.SENT, "sent");
  // The cancellable set is the SDK's: cancelPendingEvent refuses anything else.
  assert.deepEqual([...CANCELLABLE_STATES], [EventStatus.QUEUED, EventStatus.NOT_SENT, EventStatus.ENCRYPTING]);
  // Every quoted status word in the source is one of the enum's values.
  const src = stripComments(readFileSync(new URL("./localEcho.ts", import.meta.url), "utf8"));
  const values = new Set<string>(Object.values(EventStatus));
  // (The one word that is not the SDK's is the row state "failed".)
  const quoted = [...src.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  assert.ok(quoted.includes("not_sent") && quoted.includes("encrypting"), "the scan read the mapping");
  for (const q of quoted) assert.ok(values.has(q) || q === "failed", `"${q}" is not an SDK EventStatus`);
});

test("retryEcho resends a failed echo in its room; a rejection is logged, not thrown", async () => {
  const calls: unknown[][] = [];
  const client = { resendEvent: (...a: unknown[]) => { calls.push(a); return Promise.reject(new Error("offline")); } };
  const room = { roomId: "!r" };
  const e = ev("not_sent");
  const errs: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    await retryEcho(client as never, room as never, e);
  } finally {
    console.error = orig;
  }
  assert.equal(calls.length, 1);
  assert.ok(calls[0]![0] === e && calls[0]![1] === room, "resendEvent(ev, room)");
  assert.equal(errs.length, 1);
});

test("retryEcho leaves an echo that is already on its way alone", async () => {
  let n = 0;
  const client = { resendEvent: () => { n++; return Promise.resolve({}); } };
  await retryEcho(client as never, {} as never, ev("sending"));
  assert.equal(n, 0);
});

test("dropEcho cancels a cancellable echo, and never throws for one mid-flight", () => {
  const cancelled: unknown[] = [];
  const client = { cancelPendingEvent: (e: unknown) => { cancelled.push(e); } };
  const e = ev("not_sent");
  dropEcho(client as never, e);
  assert.ok(cancelled.length === 1 && cancelled[0] === e);
  dropEcho(client as never, ev("sending"));
  assert.equal(cancelled.length, 1, "a SENDING echo is not cancellable");
  const throwing = { cancelPendingEvent: () => { throw new Error("cannot cancel"); } };
  assert.doesNotThrow(() => dropEcho(throwing as never, ev("queued")));
});

test("localEchoOf finds the echo a send with our own txn id left, by the SDK's local id", () => {
  // The SDK names a local echo "~" + roomId + ":" + txnId (client.js sendCompleteEvent).
  const sdk = readFileSync("node_modules/matrix-js-sdk/lib/client.js", "utf8");
  assert.match(sdk, /event_id: "~" \+ roomId \+ ":" \+ txnId,/, "the SDK changed how it names a local echo");
  const echo = { getId: () => "~!r:t7" };
  const asked: string[] = [];
  const room = { roomId: "!r", findEventById: (id: string) => { asked.push(id); return id === "~!r:t7" ? echo : undefined; } };
  assert.equal(localEchoOf(room as never, "t7"), echo);
  assert.equal(localEchoOf(room as never, "t8"), null, "no echo was made");
  assert.deepEqual(asked, ["~!r:t7", "~!r:t8"]);
});
