// ⑥ Community › Privacy (both ON by default). What leaves the browser
// for each switch position, driven through the real helper with a fake client.
// Run: node --test app/lib/matrixPrivacy.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./testSource.ts";

// lsGet reads window.localStorage; a Map stands in.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
};
const { sendsReadReceipts, sendsTyping, sendReadMarker } = await import("./matrixPrivacy.ts");

type Call = [string, ...unknown[]];
function fakeClient() {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      setRoomReadMarkers: (...a: unknown[]) => { calls.push(["setRoomReadMarkers", ...a]); return Promise.resolve({}); },
      sendReadReceipt: (...a: unknown[]) => { calls.push(["sendReadReceipt", ...a]); return Promise.resolve({}); },
    },
  };
}
const ev = { getId: () => "$e1" } as never;

test("both default ON; only a stored \"0\" turns one off", () => {
  store.clear();
  assert.equal(sendsReadReceipts(), true);
  assert.equal(sendsTyping(), true);
  store.set("chatStyle_mxReceipts", "0");
  store.set("chatStyle_mxTyping", "0");
  assert.equal(sendsReadReceipts(), false);
  assert.equal(sendsTyping(), false);
  store.set("chatStyle_mxReceipts", "1");
  assert.equal(sendsReadReceipts(), true);
});

test("receipts ON: fully-read + public + private in one /read_markers call (today's behaviour)", async () => {
  store.clear();
  const f = fakeClient();
  await sendReadMarker(f.client as never, "!r", ev);
  assert.deepEqual(f.calls, [["setRoomReadMarkers", "!r", "$e1", ev, ev]]);
});

test("receipts OFF: NO public receipt — fully-read + private only, so unread counts still clear", async () => {
  store.set("chatStyle_mxReceipts", "0");
  const f = fakeClient();
  await sendReadMarker(f.client as never, "!r", ev);
  assert.deepEqual(f.calls, [["setRoomReadMarkers", "!r", "$e1", undefined, ev]]);
});

test("threads + the DM read: one receipt of the public or the private type", async () => {
  store.clear();
  let f = fakeClient();
  await sendReadMarker(f.client as never, "!r", ev, { single: true });
  assert.deepEqual(f.calls, [["sendReadReceipt", ev, "m.read"]]);
  store.set("chatStyle_mxReceipts", "0");
  f = fakeClient();
  await sendReadMarker(f.client as never, "!r", ev, { single: true });
  assert.deepEqual(f.calls, [["sendReadReceipt", ev, "m.read.private"]]);
});

test("every receipt sender goes through the switch", () => {
  const src = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));
  assert.match(src("app/lib/readReceipts.ts"), /sendReadMarker\(client, room\.roomId, newestEvent, \{ single: thread \}\)/);
  assert.match(src("app/lib/matrixDm.ts"), /sendReadMarker\(client, room\.roomId, last, \{ single: true \}\)/);
  assert.match(src("app/features/community/NotificationMenu.tsx"), /setRoomReadMarkers!\(r\.roomId, id, sendsReadReceipts\(\) \? ev : undefined, ev\)/);
  assert.match(src("app/features/community/useTyping.ts"), /const typing = enabled && sendsTyping\(\) && text\.trim\(\) !== "";/);
  // No other file sends a receipt or typing on its own.
  const all = ["app/lib/readReceipts.ts", "app/lib/matrixDm.ts"].map(src).join("\n");
  assert.doesNotMatch(all, /\.sendReadReceipt\(|\.sendTyping\(/);
});
