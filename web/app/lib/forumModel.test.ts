import { test } from "node:test";
import assert from "node:assert/strict";
import { sortPostViews, pinnedFirst, topThreads, type ForumPostView } from "./forumModel.ts";

const p = (id: string, o: Partial<ForumPostView>): ForumPostView => ({
  roomId: "!r", roomName: "Content", id, sender: "@a:x", senderName: "a", senderAvatar: null,
  title: id, preview: "", body: "", formatted: null, tags: [], thumbnail: null,
  replyCount: 0, lastTs: 1, postedTs: 1, score: 0, myVote: null, pinned: false, ...o,
});

test("sortPostViews: new by postedTs, top by score then activity, active by lastTs", () => {
  const a = p("a", { postedTs: 1, lastTs: 9, score: 1 });
  const b = p("b", { postedTs: 5, lastTs: 2, score: 5 });
  const c = p("c", { postedTs: 3, lastTs: 3, score: 5 });
  assert.deepEqual(sortPostViews([a, b, c], "new").map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(sortPostViews([a, b, c], "top").map((x) => x.id), ["c", "b", "a"]);
  assert.deepEqual(sortPostViews([a, b, c], "active").map((x) => x.id), ["a", "c", "b"]);
});

test("pinnedFirst keeps each half's order", () => {
  const out = pinnedFirst([p("a", {}), p("b", { pinned: true }), p("c", {}), p("d", { pinned: true })]);
  assert.deepEqual(out.map((x) => x.id), ["b", "d", "a", "c"]);
});

test("topThreads: newest activity first (#237) — an older thread whose reply is newer leads, and a fresh post with no replies is never parked under older replied threads", () => {
  // The brief's case: "old" was posted first but has the newer reply.
  const old = p("old", { postedTs: 1, replyCount: 1, lastTs: 50 });
  const young = p("young", { postedTs: 10, replyCount: 0, lastTs: 10 });
  assert.deepEqual(topThreads([young, old], 4).map((t) => t.eventId), ["old", "young"]);
  // The prod shape on 2026-11-07: a post with no replies from a week ago sat LAST, under three
  // replied threads weeks older. Most recent activity puts it first.
  const fresh = p("fresh", { postedTs: 90, replyCount: 0, lastTs: 90 });
  const a = p("a", { replyCount: 2, lastTs: 40 });
  const b = p("b", { replyCount: 1, lastTs: 30 });
  const c = p("c", { replyCount: 1, lastTs: 20 });
  assert.deepEqual(topThreads([a, b, c, fresh], 4).map((t) => t.eventId), ["fresh", "a", "b", "c"]);
  // The widget's cap keeps the newest, not the replied ones.
  assert.deepEqual(topThreads([a, b, c, fresh, young], 3).map((t) => t.eventId), ["fresh", "a", "b"]);
  // The order is the Forums tab's own "active" sort — one meaning of "most recent activity".
  assert.deepEqual(topThreads([a, b, c, fresh, young], 5).map((t) => t.eventId), sortPostViews([a, b, c, fresh, young], "active").map((x) => x.id));
  assert.deepEqual(Object.keys(topThreads([a], 1)[0]!).sort(), ["eventId", "lastTs", "replyCount", "roomId", "roomName", "title"]);
});

test("topThreads restart: a body rebuilt after a restart reads the same rows whatever order the rooms answered in", () => {
  const posts = [p("a", { lastTs: 5 }), p("b", { replyCount: 2, lastTs: 3 }), p("c", { replyCount: 1, lastTs: 4 }), p("d", { lastTs: 9 })];
  const first = topThreads(posts, 3).map((t) => t.eventId);
  assert.deepEqual(first, ["d", "a", "c"]);
  assert.deepEqual(topThreads([...posts].reverse(), 3).map((t) => t.eventId), first);
});

test("topThreads retry: building twice from the same posts (the 60 s cache refilled) gives the same rows and leaves the input untouched", () => {
  const posts = [p("x", { lastTs: 2 }), p("y", { replyCount: 3, lastTs: 1 }), p("z", { lastTs: 3 })];
  const ids = posts.map((q) => q.id);
  const once = topThreads(posts, 4);
  assert.deepEqual(topThreads(posts, 4), once);
  assert.deepEqual(posts.map((q) => q.id), ids, "the input is not sorted in place");
  assert.deepEqual(once.map((t) => t.eventId), ["z", "x", "y"]);
});
