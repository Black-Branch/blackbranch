// PgUp/PgDn/Home/End scroll the chat from the composer.
// Run: node --test app/lib/chatScrollKeys.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./testSource.ts";
import { chatScrollKey, scrollChatByKey } from "./chatScrollKeys.ts";

const plain = { textEmpty: false, modified: false };

test("PgUp/PgDn are always the feed's; Home/End only when the box is empty", () => {
  assert.equal(chatScrollKey("PageUp", plain), "PageUp");
  assert.equal(chatScrollKey("PageDown", plain), "PageDown");
  assert.equal(chatScrollKey("Home", plain), null, "with text, Home is a caret key");
  assert.equal(chatScrollKey("End", plain), null);
  assert.equal(chatScrollKey("Home", { ...plain, textEmpty: true }), "Home");
  assert.equal(chatScrollKey("End", { ...plain, textEmpty: true }), "End");
  assert.equal(chatScrollKey("ArrowUp", { ...plain, textEmpty: true }), null);
});

test("a modified key is left to the browser (Ctrl+PgDn switches tabs, Shift+PgDn selects)", () => {
  assert.equal(chatScrollKey("PageDown", { textEmpty: true, modified: true }), null);
  const input = stripComments(readFileSync(new URL("../features/chat/ChatInput.tsx", import.meta.url), "utf8"));
  assert.match(input, /modified: e\.altKey \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey/, "all four modifiers count");
});

test("a page moves most of the visible height, clamped to the feed; End re-anchors to live", () => {
  const el = { scrollTop: 1000, clientHeight: 400, scrollHeight: 5000 };
  let anchored = 0, paused = 0;
  const anchor = () => { anchored++; };
  const pause = () => { paused++; };
  scrollChatByKey(el, "PageUp", anchor, pause);
  const page = 1000 - el.scrollTop;
  assert.ok(page >= 200 && page < 400, `a page is most of the visible height, not all of it (moved ${page} of 400)`);
  assert.equal(paused, 1, "an upward key pauses the engine FIRST, or its scroll event is corrected back to the bottom");
  scrollChatByKey(el, "PageDown", anchor, pause);
  assert.equal(el.scrollTop, 1000, "a page down undoes a page up");
  assert.equal(anchored, 0, "far from the bottom, a page down just moves");
  el.scrollTop = 100;
  scrollChatByKey(el, "PageUp", anchor, pause);
  assert.equal(el.scrollTop, 0, "clamped at the top");
  scrollChatByKey(el, "Home", anchor, pause);
  assert.equal(el.scrollTop, 0);
  assert.equal(paused, 2, "Home at the top already is a no-op, not a freeze of the live feed");
  el.scrollTop = 50;
  scrollChatByKey(el, "Home", anchor, pause);
  assert.equal(paused, 3, "Home with somewhere to go pauses too");
  scrollChatByKey(el, "End", anchor, pause);
  assert.equal(anchored, 1, "End goes through the anchor, not a raw scrollTop");
});

test("a page down that lands within the re-anchor slack goes back to live through the anchor", () => {
  const el = { scrollTop: 5000 - 400 - 380, clientHeight: 400, scrollHeight: 5000 };
  let anchored = 0;
  scrollChatByKey(el, "PageDown", () => { anchored++; }, () => {});
  assert.equal(anchored, 1, "340px of page from 380px above the bottom lands 40px short — the eye's bottom");
  const far = { scrollTop: 1000, clientHeight: 400, scrollHeight: 5000 };
  scrollChatByKey(far, "PageDown", () => { anchored++; }, () => {});
  assert.equal(anchored, 1, "a landing far from the bottom stays paused");
});

test("the composer hands the key to the feed BEFORE any other key handling, and the sidebar wires it", () => {
  const input = stripComments(readFileSync(new URL("../features/chat/ChatInput.tsx", import.meta.url), "utf8"));
  const fn = input.indexOf("function handleKeyDown(");
  const scroll = input.indexOf("const scrollKey = chatScrollKey(e.key,", fn);
  const escape = input.indexOf('if (e.key === "Escape")', fn);
  assert.ok(fn > 0 && scroll > fn && scroll < escape, "the scroll-key read sits at the top of handleKeyDown");
  assert.match(input.slice(scroll, scroll + 260), /if \(scrollKey && onScrollKey\) \{ e\.preventDefault\(\); onScrollKey\(scrollKey\); return; \}/);
  assert.match(input, /textEmpty: input\.trim\(\) === ""/);
  assert.ok(input.lastIndexOf("</form>") > scroll, "END anchor: the read reached the form");
  const sidebar = stripComments(readFileSync(new URL("../features/chat/ChatSidebar.tsx", import.meta.url), "utf8"));
  assert.match(sidebar, /onScrollKey=\{\(k\) => \{ const el = scrollRef\.current; if \(el\) scrollChatByKey\(el, k, anchorToBottom, pause\); \}\}/,
    "the sidebar hands the engine's pause to the keys");
  assert.ok(sidebar.lastIndexOf("</aside>") > sidebar.indexOf("onScrollKey="), "END anchor: the read reached the bar's end");
});
