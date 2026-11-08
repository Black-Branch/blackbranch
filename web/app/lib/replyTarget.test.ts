// A reply quote tells the truth: the original in the room is shown as it is; one not loaded is
// fetched once (shared by every quote of it) — RUN against a fake client and room.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/replyTarget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mountHook } from "./testDom.ts";
import "./testTsx.ts";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { fetchEventOnce, useReplyTarget } from "./replyTarget.ts";
const { runSignOutHooks } = await import("./plugins/session.ts");

type Raw = Record<string, unknown>;
const raw = (id: string, extra: Raw = {}): Raw => ({
  event_id: id, room_id: "!r:site.test", sender: "@casey:site.test", type: "m.room.message",
  origin_server_ts: 1, content: { msgtype: "m.text", body: `text of ${id}` }, ...extra,
});

function setup(opts: { inRoom?: Record<string, unknown>; serve?: (id: string, roomId: string) => Promise<Raw>; decrypt?: () => Promise<void>; roomId?: string } = {}) {
  const fetched: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    fetchRoomEvent: (roomId: string, id: string) => { fetched.push(id); return opts.serve ? opts.serve(id, roomId) : Promise.resolve(raw(id)); },
    decryptEventIfNeeded: opts.decrypt ?? (() => Promise.resolve()),
  });
  const room = Object.assign(new EventEmitter(), {
    roomId: opts.roomId ?? "!r:site.test",
    findEventById: (id: string) => (opts.inRoom?.[id] as MatrixEvent | undefined) ?? undefined,
  });
  return { client: client as unknown as MatrixClient, room, r: room as unknown as Room, fetched };
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

test("in room → loaded, no fetch", async () => {
  const inRoomEv = { getId: () => "$here", isRedacted: () => false } as unknown as MatrixEvent;
  const s = setup({ inRoom: { $here: inRoomEv } });
  const h = await mountHook(() => useReplyTarget(s.client, s.r, "$here"));
  assert.equal(h.current.state, "loaded");
  assert.equal(h.current.state === "loaded" && h.current.ev, inRoomEv);
  await settle();
  assert.deepEqual(s.fetched, []);
  // Deleted while on screen: the SDK redacts the event in place and the room says so.
  (inRoomEv as unknown as { isRedacted: () => boolean }).isRedacted = () => true;
  await h.act(() => { s.room.emit("Room.redaction", { getAssociatedId: () => "$here" }); });
  assert.equal(h.current.state, "deleted");
  await h.unmount();
});

test("absent → one fetch shared by two callers", async () => {
  const s = setup();
  const [a, b] = await Promise.all([fetchEventOnce(s.client, s.r, "$shared"), fetchEventOnce(s.client, s.r, "$shared")]);
  assert.deepEqual(s.fetched, ["$shared"]);
  assert.ok(a !== "unavailable" && a === b, "both callers get the one event");
  assert.equal((a as MatrixEvent).getContent().body, "text of $shared");
  // Two quotes of one message, mounted: still the one fetch, both show it.
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const g = setup({ serve: (id) => gate.then(() => raw(id)) });
  const h1 = await mountHook(() => useReplyTarget(g.client, g.r, "$shared2"));
  const h2 = await mountHook(() => useReplyTarget(g.client, g.r, "$shared2"));
  assert.equal(h1.current.state, "loading", "a quote of an unloaded original says it is loading — never 'deleted'");
  assert.equal(h2.current.state, "loading");
  release();
  await h1.act(settle);
  await h2.act(settle);
  assert.equal(h1.current.state, "loaded");
  assert.equal(h2.current.state, "loaded");
  assert.deepEqual(g.fetched, ["$shared2"]);
  await h1.unmount();
  await h2.unmount();
});

test("fetched redacted → deleted", async () => {
  const s = setup({ serve: (id) => Promise.resolve(raw(id, { content: {}, unsigned: { redacted_because: { type: "m.room.redaction", event_id: "$red", sender: "@mod:site.test", content: {}, origin_server_ts: 2 } } })) });
  const got = await fetchEventOnce(s.client, s.r, "$gone");
  assert.ok(got !== "unavailable" && got.isRedacted(), "a redacted result is returned as the event");
  const h = await mountHook(() => useReplyTarget(s.client, s.r, "$gone"));
  await h.act(settle);
  assert.equal(h.current.state, "deleted");
  await h.unmount();
});

test("404 is unavailable", async () => {
  const s = setup({ serve: () => Promise.reject(Object.assign(new Error("Event not found."), { errcode: "M_NOT_FOUND", httpStatus: 404 })) });
  assert.equal(await fetchEventOnce(s.client, s.r, "$hidden"), "unavailable");
  const h = await mountHook(() => useReplyTarget(s.client, s.r, "$hidden"));
  await h.act(settle);
  assert.equal(h.current.state, "unavailable");
  assert.deepEqual(s.fetched, ["$hidden"], "cached: the second ask did not fetch again");
  await h.unmount();
});

test("decryption failure → unavailable", async () => {
  const enc = (id: string) => raw(id, { type: "m.room.encrypted", content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "x", session_id: "s", sender_key: "k", device_id: "D" } });
  // The decrypt left it encrypted (no key) …
  const a = setup({ serve: (id) => Promise.resolve(enc(id)) });
  assert.equal(await fetchEventOnce(a.client, a.r, "$locked"), "unavailable");
  // … or threw.
  const b = setup({ serve: (id) => Promise.resolve(enc(id)), decrypt: () => Promise.reject(new Error("boom")) });
  assert.equal(await fetchEventOnce(b.client, b.r, "$locked2"), "unavailable");
});

test("redaction drops the cache entry", async () => {
  let redacted = false;
  const s = setup({ serve: (id) => Promise.resolve(redacted ? raw(id, { content: {}, unsigned: { redacted_because: { type: "m.room.redaction", event_id: "$red", sender: "@mod:site.test", content: {}, origin_server_ts: 2 } } }) : raw(id)) });
  const first = await fetchEventOnce(s.client, s.r, "$later");
  assert.ok(first !== "unavailable" && !first.isRedacted());
  redacted = true;
  s.room.emit("Room.redaction", { getAssociatedId: () => "$later" });
  const second = await fetchEventOnce(s.client, s.r, "$later");
  assert.deepEqual(s.fetched, ["$later", "$later"], "fetched again after the redaction");
  assert.ok(second !== "unavailable" && second.isRedacted());
  // Another id's redaction leaves the entry alone.
  s.room.emit("Room.redaction", { getAssociatedId: () => "$other" });
  await fetchEventOnce(s.client, s.r, "$later");
  assert.equal(s.fetched.length, 2);
});

test("the same id asked in two rooms yields two independent results", async () => {
  // A reply in room B naming an event id first fetched in room A must never quote room A's text.
  const serve = (id: string, roomId: string) => roomId === "!a:site.test"
    ? Promise.resolve(raw(id, { room_id: "!a:site.test", content: { msgtype: "m.text", body: "room A's secret" } }))
    : Promise.reject(Object.assign(new Error("Event not found."), { errcode: "M_NOT_FOUND", httpStatus: 404 }));
  const a = setup({ roomId: "!a:site.test", serve });
  const b = setup({ roomId: "!b:site.test", serve });
  const inA = await fetchEventOnce(a.client, a.r, "$crossed");
  assert.ok(inA !== "unavailable" && inA.getContent().body === "room A's secret");
  assert.equal(await fetchEventOnce(b.client, b.r, "$crossed"), "unavailable", "room B asks the server for itself");
  assert.deepEqual(b.fetched, ["$crossed"]);
});

test("a fetched event from the wrong room is unavailable", async () => {
  const s = setup({ roomId: "!b:site.test", serve: (id) => Promise.resolve(raw(id, { room_id: "!a:site.test" })) });
  assert.equal(await fetchEventOnce(s.client, s.r, "$elsewhere"), "unavailable");
});

test("sign-out empties the caches", async () => {
  const s = setup();
  await fetchEventOnce(s.client, s.r, "$mine");
  await fetchEventOnce(s.client, s.r, "$mine");
  assert.deepEqual(s.fetched, ["$mine"], "cached while signed in");
  // The site's one sign-out path (sign-out, account switch, revoked session) forgets them.
  runSignOutHooks();
  await fetchEventOnce(s.client, s.r, "$mine");
  assert.deepEqual(s.fetched, ["$mine", "$mine"], "the next person fetches afresh");
});
