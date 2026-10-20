// Tests for the one-pass thread index.
//
// threadReplies is a full live-timeline scan. Run per ROOT, the cost would be
// O(roots x events):
//   - listPosts would run TWO full scans for every top-level post
//     (lastThreadReply, then countThreadReplies — getThread only
//     short-circuits when a thread exists, and the common post has none).
//   - listThreads would scan to collect root ids, then twice more per root.
//   - every rendered MatrixMessageRow would run one for its reply chip.
// ForumView's scrollback(80) emits one refresh per paginated event, so a single
// "load older posts" click would multiply that by ~80.
//
// buildThreadIndex answers all of it in one pass. These tests pin the index's
// equivalence to the scan — including the exclusions, which are the part most
// likely to be dropped in a rewrite.
//
// Run: node --test app/lib/matrixThreadIndex.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import type { Room, MatrixEvent } from "matrix-js-sdk";
import { buildThreadIndex, threadReplies, lastThreadReply, countThreadReplies } from "./matrixThreads.ts";

type Opts = { type?: string; redacted?: boolean; rel?: Record<string, unknown> };

let seq = 0;
function ev(id: string, o: Opts = {}): MatrixEvent {
  const content: Record<string, unknown> = { body: id };
  if (o.rel) content["m.relates_to"] = o.rel;
  const ts = ++seq;
  return {
    getId: () => id,
    getType: () => o.type ?? "m.room.message",
    isRedacted: () => o.redacted ?? false,
    getContent: () => content,
    getTs: () => ts,
    getSender: () => "@a:x",
  } as unknown as MatrixEvent;
}

const reply = (id: string, root: string, o: Opts = {}) =>
  ev(id, { ...o, rel: { rel_type: "m.thread", event_id: root } });

function room(events: MatrixEvent[], threads: Record<string, number> = {}): Room {
  return {
    getLiveTimeline: () => ({ getEvents: () => events }),
    findEventById: (id: string) => events.find((e) => e.getId() === id) ?? null,
    getThread: (id: string) => (threads[id] ? { length: threads[id] } : null),
  } as unknown as Room;
}

test("groups replies under their root, in timeline order", () => {
  const r = room([ev("root1"), reply("a", "root1"), ev("root2"), reply("b", "root1"), reply("c", "root2")]);
  const ix = buildThreadIndex(r);
  assert.deepEqual(ix.get("root1")?.map((e) => e.getId()), ["a", "b"]);
  assert.deepEqual(ix.get("root2")?.map((e) => e.getId()), ["c"]);
});

test("a root with no replies is absent, not an empty array", () => {
  const ix = buildThreadIndex(room([ev("lonely")]));
  assert.equal(ix.has("lonely"), false);
  assert.equal(ix.size, 0);
});

test("EQUIVALENCE: the index matches the unindexed scan for every root", () => {
  // The property that makes the whole optimization safe. If these ever diverge,
  // posts silently show the wrong reply count.
  const events = [
    ev("r1"), reply("a", "r1"), ev("r2"),
    reply("b", "r1", { redacted: true }),         // excluded
    reply("c", "r2", { type: "m.sticker" }),      // included — stickers count
    ev("noise", { type: "m.reaction" }),          // excluded
    reply("d", "r1"),
    ev("edit", { rel: { rel_type: "m.replace", event_id: "r1" } }), // excluded
  ];
  const r = room(events);
  const ix = buildThreadIndex(r);
  for (const root of ["r1", "r2", "missing"]) {
    assert.deepEqual(
      threadReplies(r, root, ix).map((e) => e.getId()),
      threadReplies(r, root).map((e) => e.getId()),
      `index and scan disagree for ${root}`
    );
  }
});

test("redacted replies are excluded — a deleted reply must not inflate the chip", () => {
  const r = room([ev("root"), reply("a", "root"), reply("b", "root", { redacted: true })]);
  assert.deepEqual(buildThreadIndex(r).get("root")?.map((e) => e.getId()), ["a"]);
});

test("m.replace echoes are excluded — an edit is not a new reply", () => {
  const r = room([
    ev("root"),
    reply("a", "root"),
    ev("e1", { rel: { rel_type: "m.replace", event_id: "a" } }),
  ]);
  assert.equal(buildThreadIndex(r).get("root")?.length, 1);
});

test("stickers count as replies, reactions do not", () => {
  const r = room([
    ev("root"),
    reply("s", "root", { type: "m.sticker" }),
    ev("x", { type: "m.reaction", rel: { rel_type: "m.thread", event_id: "root" } }),
  ]);
  assert.deepEqual(buildThreadIndex(r).get("root")?.map((e) => e.getId()), ["s"]);
});

test("lastThreadReply reads the newest entry from the index", () => {
  const r = room([ev("root"), reply("a", "root"), reply("b", "root")]);
  const ix = buildThreadIndex(r);
  assert.equal(lastThreadReply(r, "root", ix)?.getId(), "b");
  assert.equal(lastThreadReply(r, "nope", ix), null);
});

test("countThreadReplies still PREFERS the SDK thread length over the index", () => {
  // The SDK can know of replies not yet paginated into the live timeline. Reading
  // the index length directly would silently undercount those.
  const r = room([ev("root"), reply("a", "root")], { root: 7 });
  assert.equal(countThreadReplies(r, "root", buildThreadIndex(r)), 7);
});

test("countThreadReplies falls back to the index when the SDK knows nothing", () => {
  const r = room([ev("root"), reply("a", "root"), reply("b", "root")]);
  assert.equal(countThreadReplies(r, "root", buildThreadIndex(r)), 2);
});

test("an empty root id is never indexed or looked up", () => {
  const r = room([ev("root"), reply("a", "")]);
  assert.equal(buildThreadIndex(r).has(""), false);
  assert.deepEqual(threadReplies(r, "", buildThreadIndex(r)), []);
  assert.equal(countThreadReplies(r, "", buildThreadIndex(r)), 0);
});

test("ONE pass over the timeline, regardless of how many roots are queried", () => {
  // The actual point of the change. Without the index this is 1 scan per query.
  let scans = 0;
  const events = [ev("r1"), reply("a", "r1"), ev("r2"), reply("b", "r2"), ev("r3"), reply("c", "r3")];
  const r = {
    getLiveTimeline: () => ({ getEvents: () => { scans++; return events; } }),
    getThread: () => null,
  } as unknown as Room;

  const ix = buildThreadIndex(r);
  assert.equal(scans, 1);
  for (const root of ["r1", "r2", "r3"]) countThreadReplies(r, root, ix);
  for (const root of ["r1", "r2", "r3"]) lastThreadReply(r, root, ix);
  assert.equal(scans, 1, "a query re-scanned the timeline — the index is not being consulted");
});
