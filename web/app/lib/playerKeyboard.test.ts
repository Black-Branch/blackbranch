// The player's controls must be operable without a pointer.
//
// Three defects, one component. A rendition menu toggled on `onMouseDown`
// does nothing from the keyboard — Enter/Space on a focused button fire
// `click`, never mousedown (the mousedown toggle only existed to win a race
// against a hand-rolled window-mousedown outside-close; useOutsideClick's
// contains() check dissolves the race, so both hacks go together). A control
// bar hidden with `opacity-0` while its buttons stay in the tab order lands
// focus on invisible controls. And with every reveal path pointer/touch, a
// keyboard user could never bring the bar back.
//
// The reveal fix is CSS (`has-[:focus-visible]`), not a focus handler: keyboard
// focus inside the bar keeps it visible for exactly as long as focus stays, and
// pointer clicks (which set focus but not :focus-visible) keep the
// auto-hide — a plain `focus-within` reveal would pin the bar open forever
// after any mouse click on a control.
//
// Run: node --test app/lib/playerKeyboard.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PLAYER = "app/features/player/StreamplaceThinPlayer.tsx";

function readWhole(): string {
  const src = readFileSync(join(webRoot, PLAYER), "utf8");
  assert.match(
    src.slice(-400), /iceGatheringState === "complete"[\s\S]*}\s*$/,
    `${PLAYER} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return stripComments(src);
}

test("the rendition menu opens on click, so Enter/Space open it too", () => {
  const src = readWhole();
  assert.doesNotMatch(src, /onMouseDown={\(e\) => \{ e\.stopPropagation\(\); setMenuOpen/,
    "the Quality toggle is back on onMouseDown — keyboard activation fires click, never mousedown, " +
    "so Enter/Space on the focused button do nothing");
  assert.match(src, /onClick={\(\) => setMenuOpen\(\(v\) => !v\)}/,
    "no click toggle on the Quality button");
});

test("the menu's outside-close is the shared hook, with Escape", () => {
  const src = readWhole();
  assert.doesNotMatch(src, /window\.addEventListener\("mousedown", close\)/,
    "the hand-rolled window-mousedown close is back — it races the click toggle (the reason the " +
    "toggle was ever on mousedown) and has no Escape");
  assert.match(src, /useOutsideClick\(menuWrapRef, closeMenu, \{ enabled: menuOpen, escape: true \}\)/,
    "the rendition menu's outside-close no longer goes through useOutsideClick — Escape is gone with it");
});

test("the toggle and options say what they are", () => {
  const src = readWhole();
  assert.match(src, /aria-expanded={menuOpen}/, "the Quality toggle no longer reports open/closed");
  assert.match(src, /aria-pressed={r\.name === rendition}/,
    "the active rendition is only a background color — state invisible to a SR");
});

test("keyboard focus inside the hidden control bar reveals it", () => {
  const src = readWhole();
  // Both halves, on the CONTROL BAR line: opacity alone would show controls
  // that still can't be clicked, pointer-events alone would leave them invisible.
  assert.match(src, /has-\[:focus-visible\]:opacity-100 has-\[:focus-visible\]:pointer-events-auto/,
    "the control bar has no keyboard reveal — its buttons are tabbable while opacity-0, so focus " +
    "lands on invisible controls and nothing a keyboard does brings them back");
});
