// The OBS source (/overlay/chat) opens with its rows in the HTML like the
// other chats — but it keeps its own reducer: no deleted rows, no poll cards,
// a 60-row cap, and a socket `history` frame that MERGES rather than replaces:
// after a stream-api restart that frame is empty, so a replace would wipe the
// seeded rows. Pure, pinned here.
//
// Run: node --test app/lib/chatOverlaySeed.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeOverlayHistory, seedOverlayRows } from "./chatOverlaySeed.ts";
import { CHAT_OVERLAY_CAP } from "./chatCaps.ts";
import type { ChatMsg } from "./chatMsg.ts";

const row = (id: number, extra: Partial<ChatMsg> = {}): ChatMsg => ({
  id, platform: "native", username: "Bram42", message: `m${id}`,
  isMod: false, isVip: false, isMember: false, ts: 1000 + id, ...extra,
});

test("the seed drops deleted rows and poll cards, sorts oldest first, keeps the newest cap", () => {
  const many = Array.from({ length: CHAT_OVERLAY_CAP + 5 }, (_, i) => row(i + 1));
  const out = seedOverlayRows([...many, row(200, { deleted: true }), row(201, { system: "poll" })].reverse());
  assert.equal(out.length, CHAT_OVERLAY_CAP);
  assert.equal(out[0]!.id, 6, "the oldest five fell off the front");
  assert.equal(out[out.length - 1]!.id, CHAT_OVERLAY_CAP + 5);
  assert.deepEqual(seedOverlayRows(undefined), []);
  assert.equal(CHAT_OVERLAY_CAP, 60);
});

test("an empty history frame keeps the seed; a full one merges by identity and re-sorts", () => {
  const seed = seedOverlayRows([row(1), row(2), row(3)]);
  assert.deepEqual(mergeOverlayHistory(seed, []), seed, "nothing to merge → the same array, no re-render");
  const merged = mergeOverlayHistory(seed, [row(2), row(4), row(3, { deleted: true }), row(5, { system: "poll" })]);
  assert.deepEqual(merged.map((m) => m.id), [1, 2, 4], "2 not duplicated; 4 added; the deleted 3 dropped; the poll never enters");
});

test("the merge caps like a live append", () => {
  const seed = seedOverlayRows(Array.from({ length: CHAT_OVERLAY_CAP }, (_, i) => row(i + 1)));
  const merged = mergeOverlayHistory(seed, [row(500)]);
  assert.equal(merged.length, CHAT_OVERLAY_CAP);
  assert.equal(merged[merged.length - 1]!.id, 500);
});
