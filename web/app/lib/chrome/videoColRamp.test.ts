// The video column ramp: on phones, keyboard-up does not fold bar FLOW at all
// (barVisibility.ts knows nothing of `keyboardOpen`). Instead the whole video
// column translates up as a unit — by the top bar's own token PLUS the page
// padding and frame border that sit above it (--chrome-top-h + --panel-gap +
// --frame-width; the token alone leaves part of the bar on screen) — the top bar exits via
// `Bar occluded`, the bottom bar (donate pills) rises WITH the column and
// stays on screen, and the chat's visible band grows because the column's
// bottom edge rose.
//
// The arming attribute is two-valued, not boolean: `[data-kb-ramp]` (either value) keeps the TRANSFORM armed straight
// through a panel-resize snap, so the column never un-translates mid-snap;
// `[data-kb-ramp="anim"]` additionally arms the TRANSITION, and only "anim"
// does, because that transition genuinely collides (unlayered vs. a Tailwind
// utility on the same element) with the snap's own transition when both are
// active — see check-layering.mjs's ALLOW entry, which is scoped to exactly
// that family and is only true because "anim" and the snap's
// `snapping` boolean are mutually exclusive by construction.
//
// These are static source/CSS pins; the mechanism itself (transform math,
// `html.kb-open`) is exercised by useViewportHeightVar.render.test.ts and
// keyboardLiftWiring.test.ts.
// Run: node --test app/lib/chrome/videoColRamp.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "../testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const raw = (p: string) => readFileSync(join(webRoot, p), "utf8");
const readCode = (p: string) => stripComments(raw(p));

// The one `@media (max-width: 767px)` block globals.css uses for the mobile
// seam AND the ramp. Brace-matched, not a comment-window slurp — same trap
// streamSeamMobile.test.ts's `seamBlock` and keyboardLiftWiring.test.ts's
// `phoneBlock` already guard against: `.bb-video-col` also appears in the
// DESKTOP `@media (min-width: 768px)` block a few rules down.
function phoneBlock(css: string): string {
  const open = css.indexOf("@media (max-width: 767px)");
  assert.notEqual(open, -1, "the mobile seam @media block is gone from globals.css");
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  assert.fail("unbalanced braces in the mobile seam @media block");
}

test("the ramp rule lives INSIDE the 767px phone block and translates by token + panel-gap + frame-width", () => {
  const css = stripCssComments(raw("app/globals.css"));
  const block = phoneBlock(css);

  // The token alone stops short of clearing the bar — the page's --panel-gap
  // padding and the frame's --frame-width border also sit above the bar inside
  // the column's box, so the distance is all three. The three terms live in
  // --pane-ceiling-rise, because a window layer inside the chat panel has to
  // subtract exactly this distance to find its ceiling and two hand-copied
  // calc()s would drift.
  assert.match(block,
    /html\.kb-open \.bb-video-col\[data-kb-ramp\]\s*\{[^}]*transform:\s*translateY\(calc\(-1 \* var\(--pane-ceiling-rise\)\)\);/,
    "the ramp must translate by the shared --pane-ceiling-rise token");
  assert.match(block,
    /\[data-kb-ramp-host\]\s*\{[^}]*--pane-ceiling-rise:\s*calc\(var\(--chrome-top-h\) \+ var\(--panel-gap, 12px\) \+ var\(--frame-width, 2px\)\);/,
    "the ramp's three-term distance (token + panel-gap + frame-width) is missing from the phone block");

  // Confirm it is genuinely INSIDE the 767px block, not merely present
  // somewhere later in the file: locate the block's own open/close in the
  // full stylesheet and check the rule falls between them.
  const openAt = css.indexOf("@media (max-width: 767px)");
  let depth = 0, closeAt = -1;
  for (let i = css.indexOf("{", openAt); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) { closeAt = i; break; }
  }
  assert.notEqual(closeAt, -1, "setup: could not close-match the phone block");
  const ruleAt = css.indexOf("html.kb-open .bb-video-col[data-kb-ramp]");
  assert.ok(ruleAt > openAt && ruleAt < closeAt,
    "the ramp rule sits outside the 767px block's own braces — it would then apply at desktop widths too");
});

test("only [data-kb-ramp=\"anim\"] arms the transition (not the bare attribute), and reduced motion kills it", () => {
  const block = phoneBlock(stripCssComments(raw("app/globals.css")));
  // The TRANSITION is scoped to ="anim" only —
  // the bare attribute must not also carry it, or the mutual-exclusion proof
  // the check-layering ALLOW entry relies on is false.
  assert.match(block, /\.bb-video-col\[data-kb-ramp="anim"\]\s*\{[^}]*transition:\s*transform var\(--anim-default\) var\(--anim-ease\);/,
    "the [data-kb-ramp=\"anim\"] rule no longer transitions transform on the shared tokens");
  assert.doesNotMatch(block, /\.bb-video-col\[data-kb-ramp\]\s*\{[^}]*transition:/,
    "the bare [data-kb-ramp] (any value) rule carries a transition again — that reintroduces the " +
    "unlayered-vs-Tailwind collision the two-value shape exists to avoid");
  assert.match(block, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.bb-video-col\[data-kb-ramp="anim"\]\s*\{\s*transition:\s*none;\s*\}\s*\}/,
    "reduced motion no longer reaches the [data-kb-ramp=\"anim\"] transition");
});

test("StreamView arms the two-valued ramp attribute: \"on\" while snapping (transform only), \"anim\" otherwise", () => {
  const src = readCode("app/components/StreamView.tsx");
  // A boolean attribute would let the column un-translate mid-snap (the
  // transform rule leaves the node along with the transition rule). Two values
  // keep the TRANSFORM armed through a snap ("on") and only add the TRANSITION
  // when it cannot collide ("anim", exactly when `!snapping` — the
  // check-layering ALLOW entry's proof). The condition is named once
  // (`rampArmed`) because a second consumer reads it — [data-kb-ramp-host] on
  // the root, which publishes HOW FAR the column ramps to the chat panel's
  // window layers. Two separately written booleans would drift and cap a
  // keyboard-up panel at the wrong height.
  assert.match(src, /const rampArmed = narrow && !barsHidden;/,
    "the arming condition must be named once and shared with the ramp host");
  assert.match(src, /data-kb-ramp-host=\{rampArmed \? "" : undefined\}/,
    "the root must publish the rise from the SAME boolean that arms the column");
  assert.match(src, /data-kb-ramp=\{rampArmed \? \(snapping \? "on" : "anim"\) : undefined\}/,
    "the column no longer carries the exact two-valued data-kb-ramp arming expression — compact " +
    "already pulls both bars out of flow, so the ramp must not double up with it; the transform must " +
    "stay armed through a snap (\"on\") and the transition must only arm when it cannot collide with " +
    "the panel-resize snap's transition-[flex,width,opacity] utility (\"anim\", i.e. !snapping) — see " +
    "check-layering.mjs's ALLOW entry for this file");

  // The attribute must land on the SAME element as the bb-video-col
  // class, not a wrapper — same order-agnostic-lookahead trick
  // keyboardLiftWiring.test.ts uses for chatPanelRef/bb-chat-panel.
  assert.match(src, /<div(?=[^>]*\bdata-kb-ramp=)(?=[^>]*\bbb-video-col\b)[^>]*>/,
    "data-kb-ramp and the bb-video-col class are on different elements — the CSS selector " +
    "`.bb-video-col[data-kb-ramp]` would then never match");
});

test("the video-top Bar occludes on narrow && keyboardOpen && !topHidden; the video-bottom Bar takes no occluded prop", () => {
  const src = readCode("app/components/StreamView.tsx");
  assert.match(src, /occluded=\{narrow && keyboardOpen && !bars\.topHidden\}/,
    "the video-top Bar's occlusion expression changed — it must stay off once mobile compact " +
    "has already pulled the bar out of flow (topHidden), or Bar receives hidden AND occluded at once");

  const embedCall = src.match(/<StreamEmbedBar[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(embedCall, "setup: could not find the <StreamEmbedBar /> call");
  assert.match(embedCall, /\boccluded=\{narrow && keyboardOpen && !bars\.topHidden\}/,
    "occluded is not passed to StreamEmbedBar");

  const metaCall = src.match(/<StreamMetaBar[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(metaCall, "setup: could not find the <StreamMetaBar /> call");
  assert.doesNotMatch(metaCall, /\boccluded=/,
    "the video-bottom Bar (donate pills) took an occluded prop — it must stay fully visible " +
    "and interactive while the ramp is armed; only the top bar occludes");

  // Vacuity anchor at the END of the file: prove this really is the live
  // component, not a truncated read.
  assert.match(src, /const GuestSupportContent = dynamic\([\s\S]*\);\s*$/);
});

test("StreamEmbedBar accepts occluded and forwards it straight to Bar", () => {
  const src = readCode("app/components/StreamEmbedBar.tsx");
  assert.match(src, /occluded:\s*boolean;/, "the occluded prop is missing from StreamEmbedBarProps");
  assert.match(src, /<Bar[\s\S]{0,120}occluded=\{occluded\}/,
    "StreamEmbedBar no longer forwards occluded to Bar");
  assert.match(src, /\/>\s*\);\s*\}\s*$/, "vacuity anchor");
});

test("barVisibility.ts no longer knows the keyboard exists", () => {
  const src = readCode("app/lib/barVisibility.ts");
  assert.doesNotMatch(src, /keyboardOpen/,
    "keyboardOpen is back in barVisibility.ts — the ramp (this file's phone-block rule) is now " +
    "the ONLY thing the keyboard drives on the video column; a second consumer would let the two " +
    "disagree about what \"hidden\" means");
  // Vacuity anchor — the END of the file, so a truncated read can't go green
  // on this negative assertion.
  assert.match(src, /barsInFlow:\s*!barsHidden,\s*\};\s*\}\s*$/,
    "vacuity anchor: barVisibility's real closing return is gone — is this scanning the right file?");
});
