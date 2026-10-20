// The one renderability predicate for the main timeline, shared with the
// pinned panel's jump — a jump must never target something the list itself
// would not show (a redacted or thread-relation event, an ignored sender).
// Run: node --test app/lib/timelineRows.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { stripComments } from "./testSource.ts";
import { isTimelineRow, noteRelationIds } from "./timelineRows.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(rel: string, tail: RegExp): string {
  const src = readFileSync(join(webRoot, rel), "utf8");
  assert.match(src.slice(-300), tail, `${rel} did not end as expected — a truncated read makes every negative assertion below vacuous`);
  return stripComments(src);
}

const room = { client: { isUserIgnored: (id: string) => id === "@bot:site.test" } } as unknown as Room;

function ev(opts: {
  type?: string;
  sender?: string;
  redacted?: boolean;
  relType?: string;
  id?: string;
}): MatrixEvent {
  return {
    getId: () => opts.id ?? "$plain",
    getType: () => opts.type ?? "m.room.message",
    getSender: () => opts.sender ?? "@kid:site.test",
    isRedacted: () => opts.redacted ?? false,
    getContent: () => (opts.relType ? { "m.relates_to": { rel_type: opts.relType } } : {}),
  } as unknown as MatrixEvent;
}

test("a plain message or sticker from an ordinary sender is a row", () => {
  assert.equal(isTimelineRow(room, ev({})), true);
  assert.equal(isTimelineRow(room, ev({ type: "m.sticker" })), true);
});

test("another event type is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ type: "m.room.member" })), false);
});

test("an ignored sender is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ sender: "@bot:site.test" })), false);
});

test("a redacted (deleted) event is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ redacted: true })), false);
});

test("⑥ Deleted messages › Show a note: a deleted MESSAGE is a row (rendered as the note)", () => {
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$gone" }), { deleted: true }), true);
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$gone" }), { deleted: false }), false, "Hide (the default) keeps today's rule");
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$gone", sender: "@bot:site.test" }), { deleted: true }), false, "an ignored sender's stays hidden");
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$gone", type: "m.reaction" }), { deleted: true }), false, "a deleted reaction is no row");
});

test("⑥ …but a deleted EDIT or THREAD REPLY never becomes a note in the main timeline", () => {
  // Seen while it still said what it was (the redaction strips the relation).
  assert.equal(isTimelineRow(room, ev({ relType: "m.replace", id: "$edit1" })), false);
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$edit1" }), { deleted: true }), false);
  // A thread reply lives in its thread, not the live timeline: the timeline notes it.
  noteRelationIds(["$reply1"]);
  assert.equal(isTimelineRow(room, ev({ redacted: true, id: "$reply1" }), { deleted: true }), false);
});

test("an edit echo (m.replace) is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ relType: "m.replace" })), false);
});

test("a thread reply (m.thread) is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ relType: "m.thread" })), false);
});

test("the pinned panel's jump refuses a target the list would not show", () => {
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(
    tl,
    /const target = room\.findEventById\(id\);\s*if \(!target \|\| !isTimelineRow\(room, target, \{ deleted: showDeleted \}\)\) return false;/,
    "a jump to a redacted or thread-reply pin must say so instead of closing the panel and doing nothing",
  );
});
