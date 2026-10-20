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

test("topThreads: replied posts first by activity, then unreplied, capped, only the widget's fields", () => {
  const out = topThreads([p("a", { lastTs: 5 }), p("b", { replyCount: 2, lastTs: 3 }), p("c", { replyCount: 1, lastTs: 4 }), p("d", { lastTs: 9 })], 3);
  assert.deepEqual(out.map((t) => t.eventId), ["c", "b", "d"]);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["eventId", "lastTs", "replyCount", "roomId", "roomName", "title"]);
});
