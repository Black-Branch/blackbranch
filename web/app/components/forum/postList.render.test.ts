import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { PostList } = await import("./PostList.tsx");
import type { ForumPostView } from "../../lib/forumModel.ts";

const p = (id: string, o: Partial<ForumPostView>): ForumPostView => ({
  roomId: "!r", roomName: "Content", id, sender: "@a:site.test", senderName: "alice", senderAvatar: null,
  title: `Title ${id}`, preview: `Preview ${id}`, body: "", formatted: null, tags: ["ideas"], thumbnail: null,
  replyCount: 2, lastTs: 1788746815623, postedTs: 1788735930619, score: 3, myVote: null, pinned: false, ...o,
});
const noop = () => {};
const html = (posts: ForumPostView[], extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(PostList, {
  posts, query: "", showRoom: true, myUserId: null, isAdmin: false, votesLoaded: true, userColors: {},
  onOpen: noop, onTogglePin: noop, onVote: noop, ...extra,
}));

test("pinned posts float first and say so; the room name shows when asked", () => {
  const out = html([p("a", {}), p("b", { pinned: true })]);
  assert.ok(out.indexOf("Title b") < out.indexOf("Title a"));
  assert.match(out, /Pinned/);
  assert.match(out, /Content/);
  assert.match(out, /#ideas/);
  assert.match(out, /alice/);
});

test("empty list: a plain line, search-aware", () => {
  assert.match(html([]), /No posts yet/);
  assert.match(html([], { query: "zzz" }), /No posts match your search/);
});

test("a Discord-bridged author shows the platform icon, a site author does not", () => {
  const out = html([p("d", { sender: "@_discord_123:site.test", senderName: "Bob (Discord)" })]);
  assert.match(out, /discord/i);
});
