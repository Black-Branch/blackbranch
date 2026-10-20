// The server-rendered first frame of the Forums tab and the deep-link consume.
// Nothing here boots the Matrix client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dom, React, act } from "../../lib/testDom.ts";
import "../../lib/testTsx.ts";
const { ForumsTab } = await import("./ForumsTab.tsx");
const { createRoot } = await import("react-dom/client");

const noop = () => {};
// jsdom has no ResizeObserver; the width hook observes the pane on mount.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };

test("the SSR frame reads as loading: no failure, no sign-in hint, no boot sequence", () => {
  const out = renderToStaticMarkup(createElement(ForumsTab, { active: false, signedIn: false, openThread: null, onThreadConsumed: noop }));
  assert.equal((out.match(/Loading/g) ?? []).length, 1);
  assert.equal((out.match(/Couldn/g) ?? []).length, 0);
  assert.doesNotMatch(out, /Sign in to/);
  assert.doesNotMatch(out, /chrome-boot/);
  assert.match(out, /New Post/);
});

test("an openThread prop is consumed once: the thread is fetched and onThreadConsumed fires", async () => {
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => {
    calls.push(String(url));
    const body = String(url).includes("/api/forum/thread")
      ? { thread: { root: { roomId: "!c", roomName: "Content", id: "$e", sender: "@a:site.test", senderName: "alice", senderAvatar: null, title: "Deep-linked", preview: "", body: "", formatted: null, tags: [], thumbnail: null, replyCount: 0, lastTs: 2, postedTs: 1, score: 0, myVote: null, pinned: false }, replies: [] }, generatedAt: "2026-09-26T00:00:00.000Z" }
      : { rooms: [{ roomId: "!c", name: "Content" }], posts: [], generatedAt: "2026-09-26T00:00:00.000Z" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  let consumed = 0;
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => { root.render(React.createElement(ForumsTab, { active: true, signedIn: false, openThread: { roomId: "!c", eventId: "$e" }, onThreadConsumed: () => { consumed++; } })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.equal(consumed, 1);
    assert.ok(calls.some((u) => u.includes("/api/forum/thread?room=!c&event=%24e")), `thread fetched: ${calls.join(", ")}`);
    assert.match(el.innerHTML, /Deep-linked/);
    assert.match(el.innerHTML, /Sign in to reply/);
  } finally {
    await act(async () => { root.unmount(); });
    el.remove();
  }
});

test("a vote the server refuses is SAID, not silently reverted (a non-member's first vote)", async () => {
  const post = { roomId: "!c", roomName: "Content", id: "$p", sender: "@a:site.test", senderName: "alice", senderAvatar: null, title: "Votable", preview: "", body: "", formatted: null, tags: [], thumbnail: null, replyCount: 0, lastTs: 2, postedTs: 1, score: 0, myVote: null, pinned: false };
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    if (String(url).includes("/api/forum/vote") && init?.method === "POST") return Promise.resolve(new Response("Not Found", { status: 404 }));
    const body = { rooms: [{ roomId: "!c", name: "Content" }], posts: [post], generatedAt: "2026-09-26T00:00:00.000Z" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const el = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(el);
  const root = createRoot(el);
  try {
    await act(async () => { root.render(React.createElement(ForumsTab, { active: true, signedIn: true, openThread: null, onThreadConsumed: noop })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const up = el.querySelector('button[title="Upvote"]') as HTMLButtonElement | null;
    assert.ok(up, "the upvote arrow rendered");
    await act(async () => { up.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    assert.match(el.innerHTML, /Couldn(&#x27;|')t vote right now/);
  } finally {
    await act(async () => { root.unmount(); });
    el.remove();
  }
});
