// The "a panel must stay reachable" rule — the one a DRAG obeys and the one an
// open panel obeys when the viewport changes underneath it.
//
// A pop-up must stay inside the visible space when the view changes.
// Restoring is the other half and lives in panelGeometry.test.ts; the two use
// DIFFERENT clamps on purpose and this file pins the difference, because
// collapsing them is the obvious-looking simplification that breaks dragging.
//
// Run: node --test app/lib/panelReach.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reachableBox } from "./useDragResize.ts";
import { stripComments } from "../testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
// Comments stripped before any scan. Window's own comment explains why
// visualViewport must NOT be used, so a `doesNotMatch` over the raw source
// would be failed by its own documentation.
const read = (p: string) => stripComments(readFileSync(join(here, p), "utf8"));

const VP = { width: 1280, height: 800 };

test("a box already reachable comes back unchanged", () => {
  // The common case by far. If this moved anything, every resize event would
  // nudge every open panel.
  const b = { x: 100, y: 80, w: 384, h: 560 };
  assert.deepEqual(reachableBox(b, VP), b);
});

test("a box hanging off the right edge is LEFT there", () => {
  // Not an oversight — the drag rule allows it, so re-clamping to fully
  // inside would yank a card the user deliberately parked half off the edge
  // back into the middle the next time anything resized.
  const b = { x: 1100, y: 80, w: 384, h: 560 };   // 204px past the right edge
  assert.deepEqual(reachableBox(b, VP), b);
});

test("a box stranded past the edge is pulled back to the reachable margin", () => {
  // The rescue: a 2560px window narrowed to 1280 leaves this one invisible.
  const out = reachableBox({ x: 2000, y: 80, w: 384, h: 560 }, VP);
  assert.equal(out.x, 1280 - 48, "48px of it must remain grabbable");
  assert.equal(out.w, 384, "and the rescue must not resize it");
});

test("a box can never sit above the top of the viewport", () => {
  // A drag bar under y=0 cannot be grabbed again — the panel is unrecoverable
  // by pointer, which is why this bound is 0 and not -margin.
  assert.equal(reachableBox({ x: 100, y: -300, w: 384, h: 560 }, VP).y, 0);
  assert.equal(reachableBox({ x: 100, y: 5000, w: 384, h: 560 }, VP).y, 800 - 48);
});

test("a viewport smaller than the margin still yields a grabbable box", () => {
  // Degenerate, but the maths must not invert and produce x > the upper bound.
  const out = reachableBox({ x: 500, y: 500, w: 384, h: 560 }, { width: 30, height: 30 });
  assert.ok(out.x <= 30, "must not be left past a tiny viewport");
  assert.ok(out.y >= 0 && out.y <= 30);
});

test("the drag and the viewport-change rescue share ONE rule", () => {
  // The reason this is asserted rather than trusted: the bound is written
  // inline in the drag handler, so a second copy in Window could disagree
  // with it silently — and the disagreement would only show up as a panel that
  // jumps somewhere different depending on whether you moved it or the window
  // did.
  const drag = read("./useDragResize.ts");
  assert.match(drag, /if \(!g\.corner\) \{[\s\S]{0,400}?reachableBox\(/,
    "the drag's move branch must go through reachableBox, not its own maths");
  assert.doesNotMatch(drag, /x: Math\.min\(Math\.max\(g\.start\.x \+ dx/,
    "the inline copy of the clamp must be gone, not merely bypassed");

  const shell = read("../../components/chrome/Window.tsx");
  assert.match(shell, /addEventListener\("resize", clamp\)/,
    "an open panel must react to the window changing size");
  assert.match(shell, /addEventListener\("orientationchange", clamp\)/,
    "…and to a phone being rotated, which is the same failure on mobile");
  assert.match(shell, /reachableBox\(b, \{ width: window\.innerWidth, height: window\.innerHeight \}\)/,
    "the rescue must use the LAYOUT viewport");
  // visualViewport is the keyboard-aware box. Using it here would shove every
  // open panel upward each time the composer is focused — the opposite of the
  // rule ComposerPopover follows, which is anchored to a control the keyboard
  // genuinely moves.
  assert.doesNotMatch(shell, /visualViewport/,
    "a keyboard opening must not reposition floating panels");
});
