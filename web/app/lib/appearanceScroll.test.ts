// web/app/lib/appearanceScroll.test.ts
// Appearance window: search, saved looks and Reset stay put; the rail and the
// settings list scroll on their own. Opt-in: other windows keep one scroller.
// Run: systemd-run --user --scope -p MemoryMax=8G node --test app/lib/appearanceScroll.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, stripCssComments } from "./testSource.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, "..", rel), "utf8");
const css = stripCssComments(read("components/chrome/chrome.css"));

test("chrome: content marked data-scroll-inner turns the window body into a fixed frame", () => {
  assert.match(css, /\.chrome-window \.chrome-window-body:has\(> \[data-scroll-inner\]\) \{ display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(css, /\.chrome-window-body > \[data-scroll-inner\] \{ flex: 1 1 auto; min-block-size: 0; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.chrome-rail-layout\[data-fill\] \{ flex: 1 1 auto; min-block-size: 0; grid-template-rows: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.chrome-rail-layout\[data-fill\] > \* \{ min-block-size: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; \}/);
  assert.ok(css.trim().endsWith("}"), "vacuity anchor");
});

test("RailLayout fills on request", () => {
  const src = stripComments(read("components/chrome/RailLayout.tsx"));
  assert.match(src, /<div className="chrome-rail-layout" data-fill=\{fill \? "" : undefined\}/);
});

test("Appearance opts in: search, then the header slot, then the filling rail layout", () => {
  const body = stripComments(read("components/ChatAppearanceBody.tsx"));
  assert.match(body, /<div data-scroll-inner className="p-3" style=\{\{ containerType: "inline-size" \}\}>/);
  assert.match(body, /<div ref=\{setHeaderSlot\} className="shrink-0" \/>/);
  assert.match(body, /<RailLayout\s+fill/);
  assert.match(body, /headerSlot=\{headerSlot\}/);
});

test("ChatPrefs renders its saved looks + Reset into the slot (state stays in ChatPrefs)", () => {
  const src = stripComments(read("components/ChatSettings.tsx"));
  assert.match(src, /headerSlot \? createPortal\(/);
  assert.match(src, /\{headerSlot && resetButton\}/, "Reset joins the fixed header");
  assert.match(src, /\{!headerSlot && resetButton\}/, "elsewhere (/chat window, overlay) Reset stays at the bottom");
});
