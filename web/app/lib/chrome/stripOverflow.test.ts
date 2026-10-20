// web/app/lib/chrome/stripOverflow.test.ts
// The section strip's overflow arithmetic. Run: node --test app/lib/chrome/stripOverflow.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { overflowEdges, revealDelta, pageStep, STRIP_EDGE_PX } from "./stripOverflow.ts";

test("a strip that fits says nothing — including the Mod panel's 1px-short case at 390 px", () => {
  assert.equal(overflowEdges(0, 768, 768), null, "desktop Admin Panel: everything fits, no fade, no chevron");
  assert.equal(overflowEdges(0, 358, 359), null, "a trailing 1px divider is not 'more' (measured: Mod panel, 390 px)");
});

test("the sides that hold more tabs are the sides that say so", () => {
  assert.equal(overflowEdges(0, 358, 525), "end", "Admin Panel at 390 px on load: more to the right only");
  assert.equal(overflowEdges(80, 358, 525), "both");
  assert.equal(overflowEdges(167, 358, 525), "start", "scrolled to the end: more to the left only");
  assert.equal(overflowEdges(166.5, 358, 525), "start", "a fractional scrollLeft at the end still counts as the end");
});

test("the active tab is moved clear of the edge band only on a side that has more", () => {
  // First tab, flush at 0, nothing to its left: leave it.
  assert.equal(revealDelta(0, 60, 0, 358, 525), 0);
  // A tab under the right fade with more past it: bring its right edge to clientWidth − edge.
  assert.equal(revealDelta(300, 380, 0, 358, 525), 380 - (358 - STRIP_EDGE_PX));
  // A tab under the left fade with more before it: bring its left edge to `edge`.
  assert.equal(revealDelta(10, 80, 120, 358, 525), 10 - STRIP_EDGE_PX);
  // The last tab at the very end, nothing past it: it may sit flush.
  assert.equal(revealDelta(290, 358, 167, 358, 525), 0);
  // A tab already clear: leave it (never fight a hand scroll).
  assert.equal(revealDelta(100, 200, 50, 358, 525), 0);
});

test("one chevron press moves most of a strip, never less than a tab's worth", () => {
  assert.equal(pageStep(358), 358 - 2 * STRIP_EDGE_PX);
  assert.equal(pageStep(120), 80);
});

test("the CSS edge band and STRIP_EDGE_PX are the same number", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../components/chrome/chrome.css", import.meta.url), "utf8");
  const rules = css.match(/\.chrome-sections-wrap\[data-more="[a-z]+"\] > \.chrome-sections \{[^}]*\}/g) ?? [];
  assert.equal(rules.length, 3, "one mask rule per side: end, start, both");
  for (const r of rules) {
    assert.ok(r.includes(`#000 ${STRIP_EDGE_PX}px`) || r.includes(`#000 calc(100% - ${STRIP_EDGE_PX}px)`), `the fade starts at STRIP_EDGE_PX: ${r}`);
    // …and the text is gone by half of it, under the chevron's glyph.
    for (const px of r.match(/\d+px/g) ?? []) assert.ok(px === `${STRIP_EDGE_PX}px` || px === `${STRIP_EDGE_PX / 2}px`, r);
  }
  // No fade without overflow: the strip itself carries no mask.
  const base = css.match(/\n {2}\.chrome-sections \{[^}]*\}/)?.[0] ?? "";
  assert.ok(base.includes("overflow-x: auto"), "found the strip's own rule");
  assert.doesNotMatch(base, /mask-image/, "an always-on fade faded the last label of a strip that fits");
});
