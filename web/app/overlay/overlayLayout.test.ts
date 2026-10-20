// The OBS overlay pages must paint nothing but their content. Measured in a real browser with a
// transparent base (Playwright `omitBackground`, which is what an OBS browser source gives a
// page): html and body were already transparent, but the chat overlay's scroller drew an opaque
// dark scrollbar down the right edge of the source — a strip on stream. The layout hides
// scrollbars for every page under /overlay; scrolling still works (the chat follows the newest
// line by script).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "layout.tsx"), "utf8");
const style = /<style>\{`([\s\S]*?)`\}<\/style>/.exec(src)?.[1] ?? "";

test("the overlay layout keeps html and body transparent", () => {
  assert.match(style, /html,\s*body\s*\{[^}]*background:\s*transparent\s*!important/);
});

test("the overlay layout hides every scrollbar (standard and WebKit forms)", () => {
  assert.match(style, /\*\s*\{[^}]*scrollbar-width:\s*none/, "no scrollbar-width: none for every element");
  assert.match(style, /::-webkit-scrollbar\s*\{[^}]*display:\s*none/, "no ::-webkit-scrollbar rule (older OBS engines)");
});

test("vacuity anchor: the layout's style block was found and read to the end", () => {
  assert.ok(style.length > 40, "the <style> block was not found — the assertions above read nothing");
  assert.match(src, /export default function OverlayLayout[\s\S]*\}\s*$/);
});
