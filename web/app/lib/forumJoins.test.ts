import { test } from "node:test";
import assert from "node:assert/strict";
import { loadForumJoins, applyJoins } from "./forumJoins.ts";
import type { ReaderPost } from "./forumReader.ts";

test("loadForumJoins: scores for every room in one query, my votes only when signed in, pins as a set", async () => {
  const seen: { sql: string; params: unknown[] }[] = [];
  const pool = { query: async (sql: string, params: unknown[] = []) => {
    seen.push({ sql, params });
    if (/SUM\(vote\)/.test(sql)) return { rows: [{ event_id: "$a", score: 3 }] };
    if (/voter_matrix_id = \$2/.test(sql)) return { rows: [{ event_id: "$a", vote: 1 }] };
    if (/forum_pins/.test(sql)) return { rows: [{ event_id: "$b" }] };
    return { rows: [] };
  } };
  const j = await loadForumJoins(pool, ["!r1", "!r2"], "@me:x");
  assert.equal(j.scores.get("$a"), 3);
  assert.equal(j.myVotes.get("$a"), 1);
  assert.ok(j.pins.has("$b"));
  for (const q of seen) assert.match(q.sql, /room_id = ANY\(\$1\)/);
  assert.deepEqual(seen[0]!.params[0], ["!r1", "!r2"]);
  const anon = await loadForumJoins(pool, ["!r1"], null);
  assert.equal(anon.myVotes.size, 0);
  assert.equal(seen.filter((q) => /voter_matrix_id = \$2/.test(q.sql)).length, 1, "no my-votes query when signed out");
});

test("loadForumJoins: a failed query is empty joins, never a rejection (the list still renders)", async () => {
  const j = await loadForumJoins({ query: async () => { throw new Error("db down"); } }, ["!r"], null);
  assert.equal(j.scores.size, 0);
});

test("applyJoins fills score/myVote/pinned and proxies the thumbnail", () => {
  const p: ReaderPost = { roomId: "!r", roomName: "Content", id: "$a", sender: "@a:x", senderName: "a", senderAvatar: null, title: "t", preview: "", body: "", formatted: null, tags: [], thumbnailMxc: "mxc://site.test/abc", replyCount: 0, lastTs: 1, postedTs: 1 };
  const v = applyJoins(p, { scores: new Map([["$a", 4]]), myVotes: new Map([["$a", -1]]), pins: new Set(["$a"]) });
  assert.equal(v.score, 4); assert.equal(v.myVote, -1); assert.equal(v.pinned, true);
  assert.equal(v.thumbnail, "/api/matrix/media/thumbnail/site.test/abc?width=256&height=256&method=crop");
  assert.equal(applyJoins({ ...p, thumbnailMxc: null }, { scores: new Map(), myVotes: new Map(), pins: new Set() }).score, 0);
});
