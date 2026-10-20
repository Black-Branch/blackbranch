// Tests for the joined/invited room-list identity rule.
//
// useCommunityBootstrap re-derives BOTH lists from client.getRooms() on every
// subscribed event. RoomEvent.Receipt is by far the noisiest of those — every
// read marker from every member of every joined room fires it — and the Community
// Hub auto-joins the entire space tree, so an idle client sees a steady drip.
//
// Two brand-new arrays per event would make the whole nav tree (spaces rail,
// channel columns, invite list) reconcile for an event that by definition cannot
// change membership. Returning the PREVIOUS array when the set is unchanged makes
// those events free.
//
// The policy is mirrored here rather than imported because the helper is local to
// the hook file (which is a "use client" React module); the static guard at the
// bottom pins that the hook still uses it.
//
// Run: node --test app/lib/roomListIdentity.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Room = { roomId: string };

function keepIfUnchanged(prev: Room[], next: Room[]): Room[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return next;
  return prev;
}

const a = { roomId: "!a" };
const b = { roomId: "!b" };
const c = { roomId: "!c" };

test("THE FIX: an unchanged membership set keeps the previous array identity", () => {
  // This is the receipt case — the only thing that changed was someone's read
  // marker, so React must bail out rather than reconcile the nav tree.
  const prev = [a, b];
  assert.equal(keepIfUnchanged(prev, [a, b]), prev);
});

test("a joined room produces a new array", () => {
  const prev = [a, b];
  const next = [a, b, c];
  assert.equal(keepIfUnchanged(prev, next), next);
});

test("a left room produces a new array", () => {
  const prev = [a, b, c];
  const next = [a, b];
  assert.equal(keepIfUnchanged(prev, next), next);
});

test("a SWAP at equal length is still a change — not just length", () => {
  // The cheap length-only check would miss this and freeze the rail on a stale
  // room; a leave+join landing in the same tick is exactly that shape.
  const prev = [a, b];
  const next = [a, c];
  assert.equal(keepIfUnchanged(prev, next), next);
});

test("reordering counts as a change (conservative on purpose)", () => {
  const prev = [a, b];
  const next = [b, a];
  assert.equal(keepIfUnchanged(prev, next), next,
    "we rebuild rather than risk serving a stale order if the SDK reorders getRooms()");
});

test("empty → empty keeps identity", () => {
  const prev: Room[] = [];
  assert.equal(keepIfUnchanged(prev, []), prev);
});

test("first population returns the new array", () => {
  const prev: Room[] = [];
  const next = [a];
  assert.equal(keepIfUnchanged(prev, next), next);
});

test("identity is by room OBJECT, not room id", () => {
  // The SDK reuses Room instances, so object identity is the correct signal and
  // is strictly cheaper than comparing ids. A genuinely new instance for the same
  // id means the SDK replaced the room — rebuild.
  const prev = [a];
  const next = [{ roomId: "!a" }];
  assert.equal(keepIfUnchanged(prev, next), next);
});

// ── the shipped hook must actually use it ────────────────────────────────────

test("useCommunityBootstrap routes both setState calls through the guard", () => {
  const src = readFileSync(
    join(process.cwd(), "app", "features", "community", "useCommunityBootstrap.ts"),
    "utf8"
  );
  assert.match(src, /function keepIfUnchanged\(/, "the guard is gone");
  assert.match(src, /setRooms\(\(prev\) => keepIfUnchanged\(prev,/,
    "setRooms allocates unconditionally again — every read receipt rebuilds the nav tree");
  assert.match(src, /setInvites\(\(prev\) => keepIfUnchanged\(prev,/,
    "setInvites allocates unconditionally again");
  assert.match(src, /client\.on\(RoomEvent\.Receipt, refresh\)/,
    "the Receipt subscription is gone — if it was removed deliberately, retire this guard");
});
