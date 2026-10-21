// /help on an install with no console prints a whole list, which in the one-line notice slot runs
// off the page, with no scroll, gone after five seconds. A long notice is a bounded scrolling box that
// stays until closed.
// Run: node --test app/lib/longNotice.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./testTsx.ts";
import { isLongNotice } from "./chatNotice.ts";

const { helpText } = await import("./commands/parse.ts");

test("/help's list for a viewer, and for a mod, is long; a one-line notice is not", () => {
  assert.equal(isLongNotice(helpText("", { isMod: false, isAdmin: false })), true);
  assert.equal(isLongNotice(helpText("", { isMod: true, isAdmin: true })), true);
  assert.equal(isLongNotice("Unpinned."), false);
  assert.equal(isLongNotice("a\nb\nc"), false);
  assert.equal(isLongNotice("a\nb\nc\nd"), true);
});

test("wiring: a long notice is a bounded, scrolling box with a close, and is not timed out", () => {
  const src = readFileSync(new URL("../features/chat/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(!isLongNotice\(text\)\) noticeTimer\.current = setTimeout\(\(\) => setNotice\(null\), 5000\);/);
  assert.match(src, /\{notice && isLongNotice\(notice\) \? \(/);
  assert.match(src, /max-h-\[40vh\] overflow-y-auto/);
  assert.match(src, /onClick=\{\(\) => setNotice\(null\)\}\s*aria-label="Close"/);
});
