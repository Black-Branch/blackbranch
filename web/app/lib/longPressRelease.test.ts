// Guards the long-press release contract (defect register R-09).
//
// A long press that FIRED must cancel its own touchend. If it doesn't, the
// browser follows the release with compatibility mouse events at the release
// point, and the long-press menu is 8px BELOW that point — so the synthetic
// mousedown counts as a press outside the menu and useOutsideClick closes it
// immediately. Measured on dev before the fix: the menu opened during the hold
// and was gone the instant the finger lifted, every time. The feature only
// worked while you kept holding.
//
// Near the bottom of the viewport ContextMenu flips the menu ABOVE the press
// point instead, which puts an item under the finger — there the same synthetic
// click would have ACTIVATED that item on release. One cancel covers both.
//
// The conditional is the other half of the contract: a short tap never fired, so
// it must keep its click, or every tap-to-act on a long-pressable element dies.
// Verified with emulated touch: short tap → click fires, no menu; long press →
// no click at all, menu stays open (both near the top and near the bottom).
//
// Static guard — the hook needs a React renderer to exercise directly.
//
// Run: node --test app/lib/longPressRelease.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "app", "lib", "useLongPress.ts"), "utf8");

test("the touchend handler cancels the release ONLY when the press fired", () => {
  const end = SRC.match(/const end = useCallback\(\(([\s\S]*?)\n {2}\}, \[/);
  assert.ok(end, "useLongPress must expose a touchend handler that can cancel the event");
  const body = end[1] ?? "";
  assert.match(body, /preventDefault\(\)/,
    "a fired long press must swallow its own release, or useOutsideClick kills the menu on lift");
  assert.match(body, /if\s*\(\s*\w*[Ff]ired\w*\.current\s*\)/,
    "the cancel must be conditional — an ordinary tap still needs its click");
  const beforeGuard = body.slice(0, body.search(/if\s*\(\s*\w*[Ff]ired/));
  assert.doesNotMatch(beforeGuard, /preventDefault/,
    "preventDefault must sit INSIDE the fired check, not run for every touchend");
});

test("the fired flag is set by the timer and cleared on each new press", () => {
  assert.match(SRC, /setTimeout\(\s*\(\)\s*=>\s*\{[^}]*[Ff]ired\w*\.current = true/,
    "the flag must be set where the long press actually fires");
  assert.match(SRC, /startPos\.current = \{[\s\S]{0,120}?[Ff]ired\w*\.current = false/,
    "each new touchstart must clear the flag, or one long press mutes the next tap");
});

test("useLongPress still exposes the three touch handlers", () => {
  for (const h of ["onTouchStart", "onTouchEnd", "onTouchMove"]) {
    assert.match(SRC, new RegExp(`${h}:`), `${h} is part of the hook's contract`);
  }
});
