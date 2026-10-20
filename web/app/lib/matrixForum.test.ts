import "./legacyNamespace.setup.test.ts"; // first: this suite pins read-both (a legacy prefix is set)
import { test } from "node:test";
import assert from "node:assert/strict";
import { titleFromContent, previewFromContent, tagsFromContent, thumbnailFromContent, postTitle, postPreview, postTags } from "./matrixForum.ts";
import type { MatrixEvent } from "matrix-js-sdk";

// The content keys a forum room's posts carry (a made-up post).
const real = {
  body: "# Gadget\nA short film about a robot that learns to bake bread.\n#film #documentary",
  "net.prior.forum.title": "Gadget",
  "net.prior.forum.tags": ["film", "Documentary"],
  "net.prior.forum.body": "A short film about a robot that learns to bake bread.",
  msgtype: "m.text",
};

test("title: explicit field → first body line with # stripped → Untitled post", () => {
  assert.equal(titleFromContent(real), "Gadget");
  assert.equal(titleFromContent({ body: "## Heading line\nmore" }), "Heading line");
  assert.equal(titleFromContent({ body: "" }), "Untitled post");
  assert.equal(titleFromContent({}), "Untitled post");
});

test("preview: the explicit body wins; otherwise the title line and hashtag-only lines are dropped", () => {
  assert.equal(previewFromContent(real), "A short film about a robot that learns to bake bread.");
  assert.equal(previewFromContent({ body: "# Gadget\nSecond line\n#tag #tag2" }), "Second line");
  assert.equal(previewFromContent({ body: "> quoted fallback\n\nReal first line\nsecond" }), "second");
});

test("tags: explicit array (deduped, case-insensitively) → parsed #hashtags", () => {
  assert.deepEqual(tagsFromContent(real), ["film", "Documentary"]);
  assert.deepEqual(tagsFromContent({ "net.prior.forum.tags": ["a", "#A", "b"] }), ["a", "b"]);
  assert.deepEqual(tagsFromContent({ body: "hello #World and #world_2" }), ["World", "world_2"]);
});

test("thumbnail: an m.image or sticker with an mxc url, else null", () => {
  assert.equal(thumbnailFromContent("m.room.message", { msgtype: "m.image", url: "mxc://site.test/abc" }), "mxc://site.test/abc");
  assert.equal(thumbnailFromContent("m.sticker", { url: "mxc://site.test/s" }), "mxc://site.test/s");
  assert.equal(thumbnailFromContent("m.room.message", { msgtype: "m.image", url: "https://x" }), null);
  assert.equal(thumbnailFromContent("m.room.message", { msgtype: "m.text" }), null);
});

test("the MatrixEvent helpers are thin wrappers over the content helpers", () => {
  const ev = { getContent: () => real, getType: () => "m.room.message" } as unknown as MatrixEvent;
  assert.equal(postTitle(ev), titleFromContent(real));
  assert.equal(postPreview(ev), previewFromContent(real));
  assert.deepEqual(postTags(ev), tagsFromContent(real));
});

// Read both names: the product namespace's fields are read first; the legacy ones stay readable.
const productPost = {
  body: "Title line\nbody text\n#x",
  "app.blackbranch.forum.title": "Product title",
  "app.blackbranch.forum.tags": ["p1", "P1", "p2"],
  "app.blackbranch.forum.body": "Product body",
  msgtype: "m.text",
};

test("read-both: a post written with the product fields parses the same way", () => {
  assert.equal(titleFromContent(productPost), "Product title");
  assert.deepEqual(tagsFromContent(productPost), ["p1", "p2"]);
  assert.equal(previewFromContent(productPost), "Product body");
});

test("read-both: product fields win over legacy ones on the same post; a blank product field falls back", () => {
  const both = { ...real, ...productPost };
  assert.equal(titleFromContent(both), "Product title");
  assert.deepEqual(tagsFromContent(both), ["p1", "p2"]);
  assert.equal(previewFromContent(both), "Product body");
  const blank = { ...real, "app.blackbranch.forum.title": "  ", "app.blackbranch.forum.body": "", "app.blackbranch.forum.tags": "not-a-list" };
  assert.equal(titleFromContent(blank), "Gadget");
  assert.equal(previewFromContent(blank), "A short film about a robot that learns to bake bread.");
  assert.deepEqual(tagsFromContent(blank), ["film", "Documentary"]);
});
