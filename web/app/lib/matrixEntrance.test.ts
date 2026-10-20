// The community panel animates in when the boot sequence completes.
//
// Run: node --test app/lib/matrixEntrance.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments, cssAtRuleBodies } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const viewPath = join(here, "..", "features", "community", "MatrixView.tsx");
const cssPath = join(here, "..", "components", "chrome", "chrome.css");

test("the entrance is keyed to ready and cannot fire for a signed-out visitor", () => {
  const src = stripComments(readFileSync(viewPath, "utf8"));
  assert.match(src, /data-entered=\{[^}]*status === "ready"/,
    "the entrance flag must derive from the ready status");
  assert.match(src, /status === "notoken"/,
    "notoken must stay a branch distinct from the ready gate — a signed-out visitor's sign-in CTA must never get an entrance");
});

test("the entrance flag is a PURE derivation — no `animationend` one-shot may come back", () => {
  // `animationend` BUBBLES. A handler on the `.matrix-entrance` root receives
  // one event per animating DESCENDANT, so the FIRST child to finish would
  // strip `data-entered` out from under its still-delayed siblings and cancel
  // their animations mid-flight (in a browser: three `animationcancel` at
  // ~314 ms snapping straight to opacity 1). The stagger would become a pop,
  // with every gate green.
  //
  // It would also buy nothing. The one element such a latch could protect
  // against is the timeline's room-keyed div, which the entrance rules cannot
  // reach at all (see chrome.css); nothing they CAN reach remounts inside a
  // ready session. A CSS animation plays when its selector STARTS matching, so
  // a stable attribute replays nothing.
  const src = stripComments(readFileSync(viewPath, "utf8"));
  assert.match(src, /data-entered=\{status === "ready" \? "" : undefined\}/,
    "the flag must be exactly the status derivation, with nothing else gating it");
  assert.equal(/onAnimationEnd/.test(src), false,
    "an animationend handler here cannot tell the LAST staggered box from the first — it cancels the stagger");
  assert.equal(/matrixEnterPlayedRef/.test(src), false,
    "the one-shot latch must be gone with its handler, not left dangling");
});

test("content is VISIBLE at rest — the animation only moves it, and only while it runs", () => {
  // A region parked at opacity:0 waiting on a flag renders an empty panel the
  // moment anything about the flag goes wrong. The old form of this guard
  // matched one exact selector spelling carrying `opacity: 0`, so any other
  // way of hiding the panel at rest walked straight past it.
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  const section = css.slice(css.indexOf("@keyframes matrix-enter"));
  const keyframes = cssAtRuleBodies(section, "@keyframes matrix-enter")[0] ?? "";
  assert.match(keyframes, /to\s*\{[^}]*opacity:\s*1/,
    "the animation must END fully opaque — its fill-mode `both` holds whatever `to` says");
  assert.match(keyframes, /to\s*\{[^}]*transform:\s*none/,
    "…and un-translated");

  // Nothing OUTSIDE the keyframes may touch opacity or visibility on these
  // elements: every entrance rule is a transient animation, never a resting
  // style. (The render test proves the complementary half — that no rule here
  // selects anything at all once `data-entered` is absent.)
  const outside = section.replace(keyframes, "");
  assert.equal(/opacity|visibility|display\s*:\s*none/.test(outside), false,
    "the resting panel must not be styled by the entrance at all");
  assert.match(outside, /animation:\s*matrix-enter/, "the entrance must be an animation, not a resting style");
});

test("exactly the two REACHABLE contents-depths are covered, at all five rule-sites — a third would be dead code", () => {
  // Round 3 ruling: a `> .contents > .contents > *` rule WOULD select the
  // timeline pane's real box (it sits exactly two contents-hops down off the
  // pager), but could never actually animate it — that box carries
  // `.panel-slide-in`, unlayered (globals.css), which always beats a layered
  // chrome.css rule on the same `animation` property regardless of selector.
  // Round 2 shipped that third selector; round 3 removed it as dead code
  // that looks load-bearing. It must not come back — the timeline pane
  // already animates via `.panel-slide-in`'s own `panel-in`, on purpose.
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  const block = css.slice(css.indexOf(".matrix-entrance"));
  // Both depths must appear at all FIVE rule-sites (the base animate rule,
  // the three `:nth-child` delay rules, and the reduced-motion override) —
  // `assert.match` alone is vacuous here: with five sites sharing the same
  // selector text, dropping it from any ONE of them still leaves it
  // findable in the other four. Counting occurrences is what a break-verify
  // caught this round (round 2's test used a bare `assert.match` and did not
  // go red when the base rule's one-hop selector was removed).
  const RULE_SITES = 5;
  const oneHop = block.match(/\.matrix-entrance\[data-entered\]\s*>\s*\*:not\(\.contents\)/g) ?? [];
  const twoHop = block.match(/\.matrix-entrance\[data-entered\]\s*>\s*\.contents\s*>\s*\*/g) ?? [];
  assert.equal(oneHop.length, RULE_SITES,
    `the one-hop selector must appear, SCOPED to real boxes, at all ${RULE_SITES} rule-sites, found ${oneHop.length}`);
  assert.equal(/\.matrix-entrance\[data-entered\]\s*>\s*\*(?!:not\(\.contents\))/.test(block), false,
    "an UNSCOPED one-hop selector reappeared — off the pager it animates the boxless `display: contents` wrapper, which paints nothing and finishes first");
  assert.equal(twoHop.length, RULE_SITES,
    `the two-hop selector must appear at all ${RULE_SITES} rule-sites, found ${twoHop.length}`);
  assert.doesNotMatch(block, /\.matrix-entrance\[data-entered\]\s*>\s*\.contents\s*>\s*\.contents\s*>\s*\*/,
    "a third contents-depth reappeared — it can select the timeline's real box but can never animate it; see the CSS comment for why");
  // A bare descendant combinator (no `>` before `.contents`) is the
  // regression — it reaches arbitrarily deep, including the room-keyed
  // timeline div, and must never reappear.
  assert.doesNotMatch(block, /\.matrix-entrance\[data-entered\]\s+\.contents\s*>\s*\*/,
    "a descendant combinator reappeared — it must stay a CHILD combinator at every enumerated depth");
});

test("reduced motion removes the animation from INSIDE the media query", () => {
  // Brace-matched: a `slice` to the first "prefers-reduced-motion" plus a
  // 200-character proximity match stays green when the whole `@media` wrapper
  // is replaced by a plain rule. It proves two strings sit near each other,
  // not that the declaration is conditional on the query.
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  const bodies = cssAtRuleBodies(css, "@media (prefers-reduced-motion: reduce)")
    .filter((b) => b.includes(".matrix-entrance"));
  assert.equal(bodies.length, 1, "exactly one reduced-motion block may cancel the entrance");
  assert.match(bodies[0]!, /animation:\s*none/);
});

// ── Vacuity anchor ───────────────────────────────────────────────────────────
test("both scanned files exist and carry their landmarks", () => {
  assert.match(readFileSync(viewPath, "utf8"), /BootSequence/);
  assert.match(readFileSync(cssPath, "utf8"), /chrome-iconrail/);
});
