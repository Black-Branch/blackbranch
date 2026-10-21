// The platform indicator's `filter`: saturation AND drop-shadow, in one
// declaration (S-08 / S-09).
//
// THE TWO FAILURES this shape prevents, both runtime-proven:
//   S-08 — the DEFAULT indicator (the bar) had no shadow at all. It was never
//          in the shadow rule's selector list, and could not have been: the bar
//          is a child of the message ROW, a sibling of `.chat-msg-body`, so
//          `.chat-msg-body .chat-pi-bar-el` matches nothing.
//   S-09 — "Indic. sat" was DEAD in dot and icon mode. Two rules set `filter`
//          on the same elements — saturation at (0,1,0), the shadow at (0,2,0)
//          — and `filter` is one property, so the more specific one simply won,
//          regardless of source order. Computed filter on dot/icon was the
//          drop-shadow chain only.
//
// Both had one cause (two rules fighting over one property) and one fix (one
// declaration that composes). These pins exist because the fix depends on two
// CSS behaviours that are easy to get wrong and impossible to see in review —
// each of them was caught by measuring, not by reading.
//
// Run: node --test app/lib/piFilterCompose.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
// CSS needs stripCssComments, not stripComments: the latter ends with a pass
// that deletes every line starting with `--` (SQL comments in template
// literals), which in a stylesheet silently removes every custom-property
// declaration. The first assertion on one would fail for a reason nobody
// could see in the source.
const CSS = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
const REG = read("app", "lib", "settingsRegistry.ts");
const LAYOUT = read("app", "layout.tsx");

// The three indicators deliberately do not share one rule. They split by
// SHAPE — the bar is a 3x42 solid rect and the dot a solid circle, so their
// shadow is a `box-shadow`, off the `filter` property entirely; the icon wraps
// an SVG glyph whose alpha mask IS what the shadow is of, so it keeps the
// composed filter. See shadowDefaults.test.ts.
//
// The invariant these tests pin: no element may end up with two rules
// fighting over `filter`. The split satisfies it more strongly for the solid
// shapes — with the shadow gone from `filter`, there is nothing left to
// compose with, so nothing left to overwrite.
test("saturation and shadow never compete for `filter` on any indicator", () => {
  const solid = CSS.match(
    /\.chat-msg-row \.chat-pi-bar-el,\s*\.chat-msg-body \.chat-pi-dot-el \{([^}]*)\}/
  );
  assert.ok(solid, "the solid-shape indicator rule is gone or its selector changed");
  assert.match(solid[1]!, /filter:\s*saturate\(var\(--chat-pi-sat, 1\)\);/,
    "the bar/dot filter must carry saturation ALONE — their shadow is box-shadow now");
  assert.match(solid[1]!, /box-shadow:\s*var\(--chat-shadow-box\);/,
    "the bar/dot lost their box-shadow, so they have no shadow at all (S-08 again)");

  const icon = CSS.match(/\.chat-msg-body \.chat-pi-icon-el \{([^}]*)\}/);
  assert.ok(icon, "the icon indicator rule is gone or its selector changed");
  assert.match(icon[1]!, /filter:\s*saturate\(var\(--chat-pi-sat, 1\)\) var\(--chat-shadow-filter\)/,
    "the icon must set saturation and shadow in ONE filter declaration — two " +
    "declarations cannot compose, they overwrite, which is S-09");
});

test("the BAR is scoped to the row, not the body — or it matches nothing", () => {
  // The bar renders as a direct child of the row (ChatMessage.tsx), beside
  // `.chat-msg-body` rather than inside it. This is the whole of S-08.
  assert.match(CSS, /\.chat-msg-row \.chat-pi-bar-el/,
    "the bar's selector must be row-scoped");
  assert.doesNotMatch(CSS, /\.chat-msg-body \.chat-pi-bar-el/,
    "`.chat-msg-body .chat-pi-bar-el` matches NOTHING — the bar is not inside the body");
});

test("no second rule sets `filter` on the indicator elements", () => {
  // The standalone `.chat-pi-bar-el, .chat-pi-dot-el, .chat-pi-icon-el {
  // filter: saturate(...) }` rule is what killed the shadow. If it comes back,
  // one of the two effects dies again — silently, and only in some modes.
  assert.doesNotMatch(CSS, /^\.chat-pi-bar-el, \.chat-pi-dot-el, \.chat-pi-icon-el \{[^}]*filter:/m,
    "a second `filter` rule on the indicators is back — it will overwrite the composed " +
    "one rather than adding to it (S-09)");
});

test("shadow-OFF is an empty token stream, never the keyword `none`", () => {
  // `filter: saturate(1.8) none` is INVALID CSS: the declaration is dropped
  // whole, taking the saturation with it. So turning the Shadow toggle off
  // would have killed "Indic. sat" — the exact bug being fixed, moved.
  assert.match(REG, /const EMPTY_FILTER = "\/\*\*\/"/,
    "EMPTY_FILTER changed — it must be a non-empty value that substitutes to nothing");
  assert.match(REG, /setProp\("--chat-shadow-filter", EMPTY_FILTER\)/,
    "applyShadow must use EMPTY_FILTER for the off state, not 'none'");
  assert.doesNotMatch(REG, /setProp\("--chat-shadow-filter", "none"\)/,
    "'none' is back in applyShadow — it composes to invalid CSS");
});

test("and it is not the empty STRING, which CSSOM treats as a removal", () => {
  // `setProperty(name, "")` REMOVES the custom property, so the `:root` default
  // in globals.css comes back and the shadow stays on with the toggle off.
  // Measured against a real fallback; this is why EMPTY_FILTER is `/**/`.
  assert.doesNotMatch(REG, /setProp\("--chat-shadow-filter", ""\)/,
    "an empty string removes the property and the :root default wins");
  assert.doesNotMatch(LAYOUT, /setProperty\('--chat-shadow-filter', ''\)/,
    "same trap in the prepaint mirror");
});

test("the prepaint mirror emits the same off-value", () => {
  // check-prepaint proves the KEY is mirrored; it does not compare values.
  assert.match(LAYOUT, /setProperty\('--chat-shadow-filter', '\/\*\*\/'\)/,
    "the prepaint mirror must use the same empty token stream as EMPTY_FILTER, or " +
    "the indicator loads one way and settles another");
});

test("the false-equivalence claim stays deleted (S-10)", () => {
  // text-shadow "A, B" and filter "drop-shadow(A) drop-shadow(B)" are NOT the
  // same: filters chain, so B shadows the glyph plus A's shadow. Measured at
  // 1.77x the ink on the same glyph. The old comment asserted the opposite and
  // is why nobody looked.
  assert.doesNotMatch(REG, /guarantees badges\/dot\/avatar\/text sit on the theme identically/,
    "the false equivalence claim is back in settingsRegistry — it is measurably wrong");
});
