// The row toolbar must be reachable without a pointer.
//
// `.row-actions` is display:none until revealed, and the pointer reveals are
// `:hover` (gated to (hover: hover)) and the long-press `[data-open]` flag.
// display:none also removes the bar's buttons from the tab order, so without
// a keyboard reveal a keyboard user could never reach reply/vote/pin/mod-delete
// — and the ⋯ overflow fallback lives INSIDE the same hidden bar, so there is
// no second path.
//
// The reveal keys on the row's OTHER tab stops: both consumers (ChatMessage's
// username button, MatrixMessageRow's body buttons) put focusables in the row
// body, so focus enters the row before the bar is needed, the reveal fires, and
// the next Tab lands in the now-visible bar.
//
// `:has(:focus-visible)`, NOT bare `:focus-within`, and that is load-bearing:
// Android Chrome focuses a <button> on tap, so `:focus-within` would make a
// plain tap on a username reveal a toolbar that overhangs the row above and
// steals the next tap. Pointer focus does not match `:focus-visible`; keyboard
// focus does. Pre-`:has` Firefox (<121) degrades to no keyboard reveal, the
// same accepted degradation as the Bar's data-chrome-grow `:has()` rule.
//
// Run: node --test app/lib/rowActionsKeyboard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(webRoot, p), "utf8");

/** Whole-file proof at the END — a truncated read makes every assertion below
 *  it vacuous, and the negative one ("not inside the hover block") vacuously
 *  green, which is the dangerous direction. */
function readWhole(path: string, tailAnchor: RegExp, strip: (s: string) => string): string {
  const src = read(path);
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return strip(src);
}

const CSS_TAIL = /timer-delta-fade[\s\S]*}\s*$/;

/** The `@media (hover: hover)` block, extracted by brace counting — regex alone
 *  cannot see nesting, and "outside the hover gate" is the actual invariant. */
function hoverBlock(css: string): string {
  const start = css.indexOf("@media (hover: hover)");
  assert.notEqual(start, -1, "the (hover: hover) gate is gone from globals.css — if the touch fix moved, update this test to follow it");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  assert.fail("unbalanced braces after @media (hover: hover)");
}

test("keyboard focus reveals the row toolbar, outside the pointer gate", () => {
  const css = readWhole("app/globals.css", CSS_TAIL, stripCssComments);
  const rule = /\.group:has\(:focus-visible\)\s*>\s*\.row-actions\s*\{[^}]*display:\s*flex;[^}]*opacity:\s*1;[^}]*\}/;
  assert.match(css, rule,
    ".row-actions has no keyboard reveal — display:none removes its buttons from the tab order, " +
    "and every reveal is a pointer gesture, so reply/vote/pin/mod-delete are keyboard-unreachable");

  // Inside the (hover: hover) block the rule would not exist on touch devices —
  // exactly the users whose only keyboard is an external one.
  assert.doesNotMatch(hoverBlock(css), /:focus-visible/,
    "the keyboard reveal moved inside the (hover: hover) gate — a touch device with an external keyboard loses it");
});

test("the reveal keys on :focus-visible, never bare :focus-within", () => {
  // `:focus-within` matches pointer-initiated focus: Android Chrome focuses a
  // tapped <button>, so a plain tap on a username would reveal the overhanging
  // toolbar again — ticket 13's bug, reintroduced through the a11y fix.
  const css = readWhole("app/globals.css", CSS_TAIL, stripCssComments);
  assert.doesNotMatch(css, /\.group:focus-within\s*>\s*\.row-actions/,
    "bare :focus-within on the row reveal — tap-focus on Android re-opens the uninvited toolbar");
});

test("both consumer rows keep a tab stop in the row body (the reveal's premise)", () => {
  // The reveal only works because focus can ENTER the row while the bar is
  // still display:none. If a refactor removed the last always-tabbable element
  // from a row body, the rule above would sit green while the bar went back to
  // being unreachable.
  const chat = readWhole(
    "app/features/chat/ChatMessage.tsx",
    /<\/div>\s*\)\s*;\s*}\s*\)\s*;\s*$/, stripComments);
  assert.match(chat, /className={`group relative/,
    "ChatMessage's row lost its `group` class — the reveal selector no longer matches it");
  assert.match(chat, /onClick={\(e\) => onUsernameClick\?\.\(msg, e\.currentTarget\)}/,
    "ChatMessage's username button is gone — no tab stop left in the row body to trigger the reveal");

  const matrix = readWhole(
    "app/components/MatrixMessageRow.tsx",
    /export const MatrixMessageRow = memo\(MatrixMessageRowImpl, rowPropsEqual\);\s*$/, stripComments);
  assert.match(matrix, /className={`group relative/,
    "MatrixMessageRow's row lost its `group` class — the reveal selector no longer matches it");
});
