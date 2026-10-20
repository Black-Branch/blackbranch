import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../../lib/testTsx.ts";
const { ThreadView } = await import("./ThreadView.tsx");

const root = { roomId: "!r", roomName: "Content", id: "$root", sender: "@m:site.test", senderName: "morgan", senderAvatar: null, title: "Stream lead-up videos", preview: "A few ideas", body: "A few ideas for the pre-stream.", formatted: "<p>A few <b>ideas</b> for the pre-stream.</p>", tags: ["ideas"], thumbnail: null, replyCount: 1, lastTs: 2, postedTs: 1, score: 0, myVote: null, pinned: false };
const reply = { id: "$r1", sender: "@b:site.test", senderName: "bram", senderAvatar: null, body: "this one first", formatted: null, ts: 2 };
const noop = () => {};

test("renders the root with its HTML body sanitised, the replies, and the composer slot", () => {
  const out = renderToStaticMarkup(createElement(ThreadView, { thread: { root, replies: [reply] }, loading: false, error: false, composer: createElement("p", null, "COMPOSER"), userColors: {}, onBack: noop }));
  assert.match(out, /Stream lead-up videos/);
  // sanitizeMatrixHtml degrades to plain text when there is no DOMParser (the
  // server render, and node --test) — so the words must be there, not the <b>.
  assert.match(out, /A few ideas for the pre-stream\./);
  assert.match(out, /bram/);
  assert.match(out, /this one first/);
  assert.match(out, /COMPOSER/);
  assert.match(out, /aria-label="Back"/);
});

test("loading and failure read as such; a thread with no replies invites the first one", () => {
  assert.match(renderToStaticMarkup(createElement(ThreadView, { thread: null, loading: true, error: false, composer: null, userColors: {} })), /Loading/);
  assert.match(renderToStaticMarkup(createElement(ThreadView, { thread: null, loading: false, error: true, composer: null, userColors: {} })), /Couldn/);
  assert.match(renderToStaticMarkup(createElement(ThreadView, { thread: { root, replies: [] }, loading: false, error: false, composer: null, userColors: {} })), /No replies yet/);
});

test("a hostile formatted body cannot script", () => {
  const evil = { ...root, formatted: `<p>hi</p><script>alert(1)</script><img src=x onerror=alert(1)>` };
  const out = renderToStaticMarkup(createElement(ThreadView, { thread: { root: evil, replies: [] }, loading: false, error: false, composer: null, userColors: {} }));
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /onerror/);
});
