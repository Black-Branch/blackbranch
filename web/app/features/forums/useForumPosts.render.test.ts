import { test } from "node:test";
import assert from "node:assert/strict";
import { mountHook, serveJson, React } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { useForumPosts } = await import("./useForumPosts.ts");

const body = {
  rooms: [{ roomId: "!c", name: "Content" }],
  posts: [{ roomId: "!c", roomName: "Content", id: "$a", sender: "@a:site.test", senderName: "alice", senderAvatar: null, title: "T", preview: "", body: "", formatted: null, tags: [], thumbnail: null, replyCount: 0, lastTs: 2, postedTs: 1, score: 1, myVote: null, pinned: false }],
  generatedAt: "2026-09-26T00:00:00.000Z",
};
const tick = async (h: { act: (fn: () => Promise<void>) => Promise<void> }) => h.act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test("active: fetches the room's posts once on mount and exposes rooms + posts", async () => {
  const calls: string[] = [];
  serveJson(body);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return realFetch(url); }) as typeof fetch;
  const h = await mountHook(() => useForumPosts(true, "all"));
  try {
    await tick(h);
    assert.deepEqual(calls, ["/api/forum/posts?room=all&sort=active"]);
    assert.equal(h.current.data?.rooms[0]?.name, "Content");
    assert.equal(h.current.loading, false);
    assert.equal(h.current.error, false);
    assert.equal(h.current.unavailable, false);
  } finally {
    await h.unmount();
  }
});

test("a room change refetches for that room (! is not percent-encoded)", async () => {
  const calls: string[] = [];
  serveJson(body);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return realFetch(url); }) as typeof fetch;
  // The probe re-renders only on a state change, so the room lives in state.
  let setRoom: (r: string) => void = () => {};
  const h = await mountHook(() => {
    const [room, set] = React.useState("all");
    setRoom = set;
    return useForumPosts(true, room);
  });
  try {
    await tick(h);
    await h.act(async () => { setRoom("!c"); });
    await tick(h);
    assert.deepEqual(calls, ["/api/forum/posts?room=all&sort=active", "/api/forum/posts?room=!c&sort=active"]);
  } finally {
    await h.unmount();
  }
});

test("inactive: no request at all — an approaching pane must not poll", async () => {
  let calls = 0;
  globalThis.fetch = (() => { calls++; return Promise.resolve(new Response("{}")); }) as typeof fetch;
  const h = await mountHook(() => useForumPosts(false, "all"));
  try {
    await tick(h);
    assert.equal(calls, 0);
    assert.equal(h.current.data, null);
  } finally {
    await h.unmount();
  }
});

test("patch rewrites one post locally without a fetch (optimistic votes)", async () => {
  serveJson(body);
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => { calls++; return realFetch(url); }) as typeof fetch;
  const h = await mountHook(() => useForumPosts(true, "all"));
  try {
    await tick(h);
    await h.act(async () => { h.current.patch("$a", (p) => ({ ...p, score: 9 })); });
    assert.equal(h.current.data?.posts[0]?.score, 9);
    assert.equal(calls, 1);
  } finally {
    await h.unmount();
  }
});

test("a 503 is 'unavailable', not a generic error, and leaves no body", async () => {
  globalThis.fetch = (() => Promise.resolve(new Response('{"error":"forums_unavailable"}', { status: 503, headers: { "content-type": "application/json" } }))) as typeof fetch;
  const h = await mountHook(() => useForumPosts(true, "all"));
  try {
    await tick(h);
    assert.equal(h.current.unavailable, true);
    assert.equal(h.current.error, false);
    assert.equal(h.current.data, null);
  } finally {
    await h.unmount();
  }
});

test("the manual refresh event refetches", async () => {
  let calls = 0;
  serveJson(body);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string) => { calls++; return realFetch(url); }) as typeof fetch;
  const h = await mountHook(() => useForumPosts(true, "all"));
  try {
    await tick(h);
    await h.act(async () => { window.dispatchEvent(new window.Event("bb:forum-refresh")); });
    await tick(h);
    assert.equal(calls, 2);
  } finally {
    await h.unmount();
  }
});
