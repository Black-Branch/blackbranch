// The popped-out user card follows the room's deletions and purges (U8).
//
// The card read `.id` off a `delete` frame that carries `messageId`, and had no
// purge handler, so a removed line stayed on the card. Frames below are built
// in the exact shapes stream-api's chat-mod.js broadcasts.
//
// Run: node --test app/lib/userLiveFrames.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyCardFrame } from "./userLiveFrames.ts";
import { stripComments } from "./testSource.ts";
import type { ChatMsg } from "./chatMsg.ts";

const line = (id: number | string, platform = "twitch", publicId = "pub-casey"): ChatMsg =>
  ({ id, platform, username: "casey", message: `line ${id}`, isMod: false, isVip: false, isMember: false, ts: 1, publicId });
const viewer = { mine: (m: ChatMsg) => m.publicId === "pub-casey", showDeleted: false };
const mod = { ...viewer, showDeleted: true };

test("a delete frame (platform + messageId) removes the line from the card", () => {
  const prev = [line(1), line(2)];
  const next = applyCardFrame(prev, { type: "delete", platform: "twitch", messageId: 2 }, viewer);
  assert.deepEqual(next.map((m) => m.id), [1]);
});

test("a delete matches platform as well as id — the same id on another platform is a different line", () => {
  const prev = [line(5, "twitch"), line(5, "kick")];
  const next = applyCardFrame(prev, { type: "delete", platform: "kick", messageId: 5 }, viewer);
  assert.deepEqual(next.map((m) => m.platform), ["twitch"]);
});

test("a string wire id still matches a numeric row id", () => {
  const next = applyCardFrame([line(7)], { type: "delete", platform: "twitch", messageId: "7" }, viewer);
  assert.equal(next.length, 0);
});

test("a purge removes every listed line", () => {
  const prev = [line(1), line(2), line(3)];
  const next = applyCardFrame(prev, {
    type: "purge", batchId: null,
    ids: [{ platform: "twitch", id: 1 }, { platform: "twitch", id: 3 }],
  }, viewer);
  assert.deepEqual(next.map((m) => m.id), [2]);
});

test("a moderator who opted in keeps the removed line struck out, like the main chat", () => {
  const next = applyCardFrame([line(1)], { type: "delete", platform: "twitch", messageId: 1 }, mod);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.deleted, true);
  const purged = applyCardFrame([line(2)], { type: "purge", batchId: null, ids: [{ platform: "twitch", id: 2 }] }, mod);
  assert.equal(purged[0]!.deleted, true);
});

test("history replay drops lines already deleted, except for the opted-in moderator", () => {
  const msgs = [line(1), { ...line(2), deleted: true }, line(3, "twitch", "someone-else")];
  assert.deepEqual(applyCardFrame([], { type: "history", messages: msgs }, viewer).map((m) => m.id), [1]);
  assert.deepEqual(applyCardFrame([], { type: "history", messages: msgs }, mod).map((m) => m.id), [1, 2]);
});

test("a new line from this person is added; someone else's is not", () => {
  const added = applyCardFrame([], { type: "message", ...line(9) }, viewer);
  assert.equal(added.length, 1);
  const other = applyCardFrame(added, { type: "message", ...line(10, "twitch", "someone-else") }, viewer);
  assert.equal(other, added, "unchanged buffer is returned as-is");
});

test("the hook hands frames to the reducer — no hand-written frame cast left in it", () => {
  const src = stripComments(readFileSync(new URL("./useUserLiveMessages.ts", import.meta.url), "utf8"));
  assert.match(src, /applyCardFrame\(prev, data, view\)/);
  assert.doesNotMatch(src, /\bas \{/, "a frame cast to a hand-written shape is how `.id` was read off a `messageId` frame");
  assert.doesNotMatch(src, /as unknown as/);
  // END anchor: the hook's last line.
  assert.match(src.trimEnd(), /return msgs;\n\}$/);
});
