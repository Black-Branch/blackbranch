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
import { isTimelineRow, isVerificationEvent, noteRelationIds } from "./timelineRows.ts";

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
  content?: Record<string, unknown>;
  /** The relation an encrypted event carries in the clear (its wire content). */
  wireRelType?: string;
}): MatrixEvent {
  return {
    getId: () => opts.id ?? "$plain",
    getType: () => opts.type ?? "m.room.message",
    getSender: () => opts.sender ?? "@kid:site.test",
    isRedacted: () => opts.redacted ?? false,
    getContent: () => opts.content ?? (opts.relType ? { "m.relates_to": { rel_type: opts.relType } } : {}),
    getWireContent: () => (opts.wireRelType ? { algorithm: "m.megolm.v1.aes-sha2", "m.relates_to": { rel_type: opts.wireRelType, event_id: "$x" } } : {}),
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

test("`m.key.verification.request` (event type) is not a row", () => {
  assert.equal(isTimelineRow(room, ev({ type: "m.key.verification.request" })), false);
});

test("`m.key.verification.start`/`.ready`/`.done` are not rows", () => {
  for (const t of ["m.key.verification.start", "m.key.verification.ready", "m.key.verification.done", "m.key.verification.cancel", "m.key.verification.key", "m.key.verification.mac", "m.key.verification.accept"]) {
    assert.equal(isTimelineRow(room, ev({ type: t })), false, t);
    assert.equal(isVerificationEvent(ev({ type: t })), true, t);
  }
});

test("a room message with `msgtype: m.key.verification.request` is not a row", () => {
  // The exact shape another client (Element, FluffyChat) sends to start emoji verification in a DM:
  // its body is the fallback text that used to show as a chat line in the DM window.
  const request = ev({
    content: {
      msgtype: "m.key.verification.request",
      body: "@casey:site.test is requesting to verify your key, but your client does not support in-chat key verification. You will need to use legacy key verification to verify keys.",
      to: "@kid:site.test",
      from_device: "PHONEDEV",
      methods: ["m.sas.v1", "m.qr_code.show.v1", "m.reciprocate.v1"],
    },
  });
  assert.equal(isTimelineRow(room, request), false);
  assert.equal(isVerificationEvent(request), true);
  assert.equal(isVerificationEvent(ev({ content: { msgtype: "m.text", body: "verify me" } })), false, "an ordinary message is not");
  assert.equal(isTimelineRow(room, ev({ content: { msgtype: "m.text", body: "m.key.verification.request" } })), true, "a message merely naming it is a row");
});

test("an `m.room.encrypted` row is kept as a lock row", () => {
  // Still being decrypted: a row from the start, so the timeline does not jump when it resolves.
  assert.equal(isTimelineRow(room, ev({ type: "m.room.encrypted" })), true);
  // …but an encrypted reaction, edit, thread reply or verification step says what it is in the
  // clear, and is never a row (it would flash a lock and vanish).
  for (const rel of ["m.annotation", "m.replace", "m.thread", "m.reference"]) {
    assert.equal(isTimelineRow(room, ev({ type: "m.room.encrypted", wireRelType: rel })), false, rel);
  }
  // A failed decryption reads as m.room.message (m.bad.encrypted) with its relation only on the wire.
  assert.equal(isTimelineRow(room, ev({ content: { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" } })), true);
  assert.equal(isTimelineRow(room, ev({ content: { msgtype: "m.bad.encrypted", body: "** Unable to decrypt **" }, wireRelType: "m.annotation" })), false, "a failed reaction is no row");
});

test("a poll started in another Matrix app: both spellings are rows", () => {
  // Element and other MSC3381 clients send the unstable type; the stable name is `m.poll.start`.
  assert.equal(isTimelineRow(room, ev({ type: "org.matrix.msc3381.poll.start" })), true, "unstable spelling");
  assert.equal(isTimelineRow(room, ev({ type: "m.poll.start" })), true, "stable spelling");
  // Votes and the end of a poll are references to it, never rows of their own.
  for (const t of ["org.matrix.msc3381.poll.response", "m.poll.response", "org.matrix.msc3381.poll.end", "m.poll.end"]) {
    assert.equal(isTimelineRow(room, ev({ type: t, relType: "m.reference" })), false, t);
  }
  assert.equal(isTimelineRow(room, ev({ type: "m.poll.start", sender: "@bot:site.test" })), false, "an ignored sender's poll stays hidden");
  assert.equal(isTimelineRow(room, ev({ type: "m.poll.start", relType: "m.thread", id: "$pollInThread" })), false, "a poll started in a thread lives in the thread");
});

test("restart: a poll is a row on every fresh read of the same event (no state carried in)", () => {
  // A reload re-reads the event from the store; the rule depends on the event alone.
  const first = isTimelineRow(room, ev({ type: "org.matrix.msc3381.poll.start", id: "$poll1" }));
  const again = isTimelineRow(room, ev({ type: "org.matrix.msc3381.poll.start", id: "$poll1" }));
  assert.equal(first, true);
  assert.equal(again, true);
});

test("retry: an encrypted poll is a lock row, and still a row once decryption succeeds", () => {
  // The SDK swaps the same event's type from m.room.encrypted to the poll's type on decrypt;
  // the row must not vanish (the list would jump).
  let type = "m.room.encrypted";
  const e = { ...ev({ id: "$encPoll" }), getType: () => type } as unknown as MatrixEvent;
  assert.equal(isTimelineRow(room, e), true, "the lock row while decrypting");
  type = "org.matrix.msc3381.poll.start";
  assert.equal(isTimelineRow(room, e), true, "the poll card after the key arrives");
  // An encrypted vote carries its reference in the clear: never a row, before or after.
  assert.equal(isTimelineRow(room, ev({ type: "m.room.encrypted", wireRelType: "m.reference" })), false);
});

test("⑥ Deleted messages › Show a note: a deleted poll is a note like a deleted message", () => {
  assert.equal(isTimelineRow(room, ev({ type: "m.poll.start", redacted: true, id: "$gonePoll" }), { deleted: true }), true);
  assert.equal(isTimelineRow(room, ev({ type: "m.poll.start", redacted: true, id: "$gonePoll" })), false);
});

test("the pinned panel's jump refuses a target the list would not show", () => {
  // The jump is the shared room engine's (useRoomTimeline.ts, client polish Task 11), which the
  // timeline runs on and hands to the pinned panel.
  const tl = read("app/features/community/Timeline.tsx", /<\/div>\s*\);\s*}\s*$/);
  assert.match(tl, /useRoomTimeline\(client, room, \{ showDeleted, myUserId, baseLimit \}\)/, "the timeline runs on the shared room engine (useRoomTimeline.ts, Task 11)");
  const eng = read("app/lib/useRoomTimeline.ts", /phase,\s*};\s*}\s*$/);
  assert.match(
    eng,
    /const target = room\.findEventById\(id\);\s*if \(!target \|\| !isTimelineRow\(room, target, \{ deleted: showDeleted \}\)\) return false;/,
    "a jump to a redacted or thread-reply pin must say so instead of closing the panel and doing nothing",
  );
});
