import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { ForumsView } = await import("./ForumsView.tsx");
import type { ForumsViewProps } from "./ForumsView.tsx";
import type { ForumPostView } from "../../lib/forumModel.ts";

const post = (id: string, o: Partial<ForumPostView> = {}): ForumPostView => ({ roomId: "!c", roomName: "Content", id, sender: "@a:site.test", senderName: "alice", senderAvatar: null, title: `T ${id}`, preview: "", body: "", formatted: null, tags: [], thumbnail: null, replyCount: 0, lastTs: 2, postedTs: 1, score: 0, myVote: null, pinned: false, ...o });
const noop = () => {};
const base: ForumsViewProps = {
  rooms: [{ roomId: "!c", name: "Content" }, { roomId: "!m", name: "Memes" }], posts: [post("a"), post("b", { pinned: true })], loading: false, error: false, unavailable: false,
  room: "all", onRoom: noop, sort: "active", onSort: noop, query: "", onQuery: noop,
  thread: null, threadOpen: false, threadLoading: false, threadError: false, onCloseThread: noop,
  wide: true, tight: false, signedIn: false, myUserId: null, isAdmin: false, userColors: {},
  hint: null, composer: null, onOpen: noop, onTogglePin: noop, onVote: noop, onNewPost: noop, onRetry: noop,
};
const html = (p: Partial<ForumsViewProps>) => renderToStaticMarkup(createElement(ForumsView, { ...base, ...p }));

test("chips: All plus one per room, the chosen one pressed; pinned first; New Post present even signed out", () => {
  const out = html({ room: "!m" });
  assert.match(out, /aria-pressed="false"[^>]*>All</);
  assert.match(out, /aria-pressed="true"[^>]*>Memes</);
  assert.match(out, /Content</);
  assert.ok(out.indexOf("T b") < out.indexOf("T a"));
  assert.match(out, /New Post/);
  assert.doesNotMatch(out, /role="tab"/);
});

test("signed out: the hint line renders and no reply composer; the thread slot says Sign in to reply", () => {
  const out = html({ hint: "Sign in to vote", threadOpen: true, thread: { root: post("a"), replies: [] }, composer: createElement("a", { href: "/auth/signin" }, "Sign in to reply") });
  assert.match(out, /Sign in to vote/);
  assert.match(out, /Sign in to reply/);
});

test("wide: list and thread side by side; narrow: the thread replaces the list with Back", () => {
  const wide = html({ threadOpen: true, thread: { root: post("a"), replies: [] } });
  assert.match(wide, /T b/); assert.match(wide, /Close thread/);
  const narrow = html({ wide: false, threadOpen: true, thread: { root: post("a"), replies: [] } });
  assert.doesNotMatch(narrow, /T b/); assert.match(narrow, /aria-label="Back"/);
});

test("states: first frame loads; failure says so with Try again; unavailable has its own line", () => {
  assert.match(html({ posts: null, rooms: null, loading: true }), /Loading/);
  assert.match(html({ posts: null, rooms: null, error: true }), /Try again/);
  // The apostrophe renders as &#x27; in static markup.
  assert.match(html({ posts: null, rooms: null, unavailable: true }), /Forums aren(&#x27;|')t available right now/);
  assert.match(html({ posts: [], rooms: [] }), /No posts yet/);
});
