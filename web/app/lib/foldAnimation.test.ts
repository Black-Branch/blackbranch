// The player fold collapses over a transition instead of in one commit — and
// EXPANDS over the same one (both directions animate).
//
// Source scans only. The lifecycle itself — what stays mounted, for how long,
// and what releases it — is RUN in usePlayerFold.render.test.ts; a scan cannot
// see a sequence of events over time (an unfold that cannot transition, or a
// `transitionend` wait with no fallback, both pass a scan).
//
// Run: node --test app/lib/foldAnimation.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments, cssAtRuleBodies } from "./testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const viewPath = join(here, "..", "components", "StreamView.tsx");
const cssPath = join(here, "..", "components", "chrome", "chrome.css");
const globalsPath = join(here, "..", "globals.css");

test("the collapse is a declared grid transition, never a measured height", () => {
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  assert.match(css, /\.player-fold-region\s*\{[^}]*grid-template-rows:\s*1fr/,
    "the open state must be 1fr");
  assert.match(css, /\.player-fold-region\[data-folding\][\s\S]{0,200}grid-template-rows:\s*0fr/,
    "the folding state must be 0fr");
  assert.match(css, /\.player-fold-region\s*\{[^}]*transition:[^;]*grid-template-rows/,
    "the rows must actually transition");
  assert.match(css, /\.player-fold-region\s*\{[^}]*overflow:\s*hidden/,
    "without overflow:hidden the content overflows the collapsing track");
});

test("reduced motion collapses instantly — the declaration is INSIDE the media query", () => {
  // Brace-matched, not a proximity match: a `slice` to the first
  // "prefers-reduced-motion" plus a 200-character proximity match stays green
  // when the entire `@media (prefers-reduced-motion: reduce) { … }` wrapper is
  // replaced by `.player-fold-region.never-matches { transition: none; }`. It
  // proves two strings sit within 200 characters of each other, never that the
  // declaration is conditional on the query at all — and reduced motion must
  // substitute an instant change for EVERY animation.
  const css = stripCssComments(readFileSync(cssPath, "utf8"));
  const bodies = cssAtRuleBodies(css, "@media (prefers-reduced-motion: reduce)")
    .filter((b) => b.includes(".player-fold-region"));
  assert.equal(bodies.length, 1, "exactly one reduced-motion block may govern the fold");
  assert.match(bodies[0]!, /\.player-fold-region\s*\{[^}]*transition:\s*none/,
    "reduced motion must substitute an instant change, and the fold must still work");
  // …and the same declaration must NOT also sit outside the query, where it
  // would kill the transition for everyone.
  const outside = css.split(bodies[0]!).join("");
  assert.equal(/\.player-fold-region\s*\{[^}]*transition:\s*none/.test(outside), false,
    "an unconditional `transition: none` would make the media query meaningless");
});

test("the fold REGION is unconditional — only the player comes and goes", () => {
  // The expand must animate too. A wrapper that unmounts while
  // folded remounts on unfold already at `grid-template-rows: 1fr`, and an
  // element with no prior computed value does not transition: the collapse
  // would animate over 300ms and the expand snap in one frame. Keeping the region
  // mounted is what gives the 0fr→1fr change something to interpolate FROM.
  const src = stripComments(readFileSync(viewPath, "utf8"));
  const region = src.indexOf('className="player-fold-region"');
  assert.notEqual(region, -1, "the fold region must still exist");
  const gate = src.indexOf("!folded || playerMounted");
  assert.notEqual(gate, -1, "the player must still be gated on the fold lifecycle");
  assert.ok(gate > region,
    "the mount gate must sit INSIDE the region, not around it — a conditional region cannot transition open");
  // The region's own JSX must carry no `&&` gate of its own.
  assert.equal(/&&\s*\(\s*<div\s+className="player-fold-region"/.test(src), false,
    "the region must not be conditionally rendered");
});

test("the player unmounts from the transition handler, not an effect", () => {
  // react-hooks/set-state-in-effect is a hard error here, and an effect chasing
  // a value already known is a cascading render.
  const src = stripComments(readFileSync(viewPath, "utf8"));
  assert.match(src, /onTransitionEnd=\{onRegionTransitionEnd\}/,
    "the unmount must be driven by the transition ending, through the fold hook");
  assert.match(src, /usePlayerFold\(folded\)/,
    "the lifecycle lives in usePlayerFold so it can be RUN by a test, not scanned");
});

test("the fold region carries the mode sizing, because .player-area no longer can", () => {
  // The region is the panel's flex child now and `.player-area` is its GRID
  // ITEM, so `flex` on `.player-area` is inert. Left there, fill mode
  // silently de-centres: the area collapses 600→338 px and the video sits
  // flush to the top.
  const css = stripCssComments(readFileSync(globalsPath, "utf8"));
  assert.match(css, /\.player-fill\s+\.player-fold-region\s*\{[^}]*flex:\s*1 1 0%/,
    "fill mode must grow the REGION, or the video is no longer centred in the column");
  assert.match(css, /\.player-attached\s+\.player-fold-region\s*\{[^}]*flex:\s*none/,
    "attached mode must pin the region, or it shrinks and its overflow:hidden clips the video");
  assert.match(css, /\.player-radio\s+\.player-fold-region\s*\{[^}]*flex:\s*none/,
    "radio the same");
  for (const mode of ["player-fill", "player-attached", "player-radio"]) {
    const rule = new RegExp(`\\.${mode}\\s+\\.player-area\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${mode} must still style .player-area`);
    assert.equal(/flex:/.test(rule[1]!), false,
      `${mode} .player-area still declares flex — inert on a grid item, and it reads as load-bearing`);
  }
});

// ── Vacuity anchor ───────────────────────────────────────────────────────────
// Three assertions above are NEGATIVE, and a negative assertion goes green over
// a hole — an empty file, a moved file, a bad join(). Anchor on the END of each
// scanned file, not a landmark near its top: that is what proves the whole file
// was read.
test("all three scanned files were read to their END", () => {
  const view = readFileSync(viewPath, "utf8").trimEnd();
  const chrome = readFileSync(cssPath, "utf8").trimEnd();
  const globals = readFileSync(globalsPath, "utf8").trimEnd();
  assert.match(view.slice(-400), /GuestSupportContent = dynamic/,
    "StreamView.tsx is truncated — its last statement is the lazy Donate import");
  assert.match(chrome.slice(-300), /\.matrix-entrance\[data-entered\]/,
    "chrome.css is truncated — the entrance's reduced-motion override is its last rule");
  assert.match(globals.slice(-300), /timer-delta-fade/,
    "globals.css is truncated — the timer-delta reduced-motion block is its last rule");
});
