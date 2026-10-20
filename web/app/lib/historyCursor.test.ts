// Pins the chat-history keyset-cursor mechanics — most importantly the
// scroll-back RUN re-seed (seedRunCursor) that closes the "history gap": the
// cursor ref is only valid within one run, because between runs the anchored
// buffer trims its front (live-message cap + re-anchor shed) while the cursor
// stays put. Reusing it would skip every message trimmed since — a hole of
// hundreds of messages between the first fetched page and the oldest visible
// row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorOf, cursorQuery, msgTs, seedRunCursor } from "./historyCursor.ts";

const histRow = {
  platform: "twitch",
  id: 157590,
  ts: 1784890214566,
  cts: "2026-07-24 03:50:14.566357-07",
};
const liveRow = { platform: "native", id: 51158, ts: 1784893030217 }; // WS frame — no cts

test("msgTs tolerates number and numeric-string timestamps", () => {
  assert.equal(msgTs({ ts: 1784890214566 }), 1784890214566);
  assert.equal(msgTs({ ts: "1784890214566" }), 1784890214566);
});

test("cursorQuery: first page is the plain ms bound", () => {
  assert.equal(cursorQuery({ beforeMs: 1784890214566 }), "before=1784890214566");
});

test("cursorQuery: keyset pages carry the full-precision triple, encoded", () => {
  const q = cursorQuery(cursorOf(histRow));
  assert.equal(
    q,
    "before=1784890214566" +
      "&beforeTs=2026-07-24%2003%3A50%3A14.566357-07" +
      "&beforePlatform=twitch&beforeId=157590"
  );
});

test("cursorOf preserves cts as the exact keyset boundary", () => {
  const c = cursorOf(histRow);
  assert.deepEqual(c, {
    beforeMs: 1784890214566,
    tsIso: histRow.cts,
    platform: "twitch",
    id: 157590,
  });
});

test("seedRunCursor: history-fetched oldest row → exact keyset cursor", () => {
  // A row that came from /api/chat/history carries cts, so a new run resumes
  // from the precise on-screen boundary — no overlap, no skip.
  assert.deepEqual(seedRunCursor(histRow), cursorOf(histRow));
});

test("seedRunCursor: live oldest row (no cts) → ms bound INCLUSIVE of its own ms", () => {
  // +1ms so same-millisecond siblings at the boundary can't be skipped; the
  // caller's (platform,id) dedupe drops the boundary row when it comes back.
  assert.deepEqual(seedRunCursor(liveRow), { beforeMs: 1784893030218 });
});

test("seedRunCursor: empty buffer seeds nothing", () => {
  assert.equal(seedRunCursor(undefined), null);
});
