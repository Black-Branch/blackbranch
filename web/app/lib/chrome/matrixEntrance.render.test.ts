// The community entrance's SELECTORS, run against a real DOM.
//
// Source scans can see the selector TEXT and nothing about which elements that
// text reaches — an entrance can cancel itself mid-stagger with every scan
// green.
//
// So this file takes the selectors as they actually ship out of chrome.css and
// hands them to jsdom's selector engine over a DOM built to the panel's real
// shape. A regex cannot answer "does this rule reach the boxless wrapper", "do
// the three delays land on three DIFFERENT boxes", or "is the reduced-motion
// override as wide as the rule it cancels". querySelectorAll can.
//
// WHAT THIS STILL CANNOT DO, stated rather than papered over: jsdom has no
// CSS animation engine, so no test here can watch `matrix-enter` play, finish,
// or be cancelled. The attribute is a pure derivation of `status` with no
// `animationend` handler at all (a bubbling handler on the root would cancel
// the stagger), which matrixEntrance.test pins. Watching the stagger actually
// run needs a real browser.
//
// Run: node --test app/lib/chrome/matrixEntrance.render.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dom } from "../testDom.ts";
import { stripCssComments, cssAtRuleBodies } from "../testSource.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "..", "components", "chrome", "chrome.css");

const css = stripCssComments(readFileSync(cssPath, "utf8"));
const section = css.slice(css.indexOf("@keyframes matrix-enter"));
const keyframeBody = cssAtRuleBodies(section, "@keyframes matrix-enter")[0] ?? "";
const reducedBody = cssAtRuleBodies(section, "@media (prefers-reduced-motion: reduce)")[0] ?? "";

/** Flat `selector { body }` pairs — nested at-rule bodies removed first. */
function rulesIn(text: string): { sel: string; body: string }[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!.trim() }))
    .filter((r) => r.sel.includes(".matrix-entrance"));
}

const flat = section.replace(keyframeBody, "").replace(reducedBody, "");
const RULES = rulesIn(flat);
const REDUCED = rulesIn(reducedBody);

const BASE = RULES.find((r) => r.body.includes("animation:"))!;
const DELAYS = RULES.filter((r) => r.body.includes("animation-delay"));

/**
 * The panel off the pager (ordinary desktop): `.matrix-entrance` is the OUTER
 * root, the pager wrapper under it is `display: contents` (no box), the real
 * regions sit one hop inside it, and the timeline pane nests a SECOND
 * `display: contents` wrapper whose room-KEYED div is the thing no entrance
 * rule may reach.
 */
function offPager(entered: boolean) {
  const host = dom.window.document.createElement("div");
  host.innerHTML = `
    <div class="flex-1 flex min-h-0 matrix-entrance"${entered ? " data-entered" : ""}>
      <div class="contents">
        <div id="rail"></div>
        <div id="dir"></div>
        <div id="divider"></div>
        <div id="mem"></div>
        <div class="contents" id="timeline-wrap">
          <div id="room" class="panel-slide-in"></div>
        </div>
      </div>
    </div>`;
  return host;
}

/** The same panel under the pager skin: the wrapper IS a box (a snap row). */
function onPager() {
  const host = dom.window.document.createElement("div");
  host.innerHTML = `
    <div class="flex-1 flex min-h-0 matrix-entrance" data-entered>
      <div class="flex flex-1 min-h-0 overflow-x-auto snap-x" id="scroller">
        <div id="pane-dir"></div>
        <div id="pane-timeline"></div>
        <div id="pane-mem"></div>
      </div>
    </div>`;
  return host;
}

const ids = (host: Element, sel: string) =>
  [...host.querySelectorAll(sel)].map((el) => el.id || `.${el.className.split(" ").pop()}`);

test("the stylesheet really does define one animate rule and three delay rules", () => {
  // Not decoration: everything below indexes into these, so an extraction that
  // silently found nothing would make every assertion in this file vacuous.
  assert.ok(BASE, "no .matrix-entrance rule carrying `animation:` was extracted");
  assert.equal(DELAYS.length, 3, "the stagger is three delayed positions");
  assert.equal(REDUCED.length, 1, "reduced motion overrides the entrance in exactly one rule");
});

test("the entrance reaches the real boxes and NOT the boxless wrapper", () => {
  // The `display: contents` wrapper has no box, so animating it paints nothing
  // — and it was the element that fired the earliest `animationend` of all and
  // triggered the cancel. `:not(.contents)` on the one-hop rule is what keeps
  // the rule to elements that can actually move.
  const host = offPager(true);
  const hit = ids(host, BASE.sel);
  assert.deepEqual(hit, ["rail", "dir", "divider", "mem", "timeline-wrap"],
    "the entrance must reach exactly the panel's own regions");
  const wrapper = host.querySelector(".matrix-entrance > .contents")!;
  assert.equal([...host.querySelectorAll(BASE.sel)].includes(wrapper), false,
    "the boxless wrapper must not be in the animated set");
});

test("the timeline's room-keyed box is out of reach at every rule-site", () => {
  // It carries `.panel-slide-in` from the UNLAYERED globals.css, which always
  // beats a chrome.css `@layer components` rule on `animation` — so a rule that
  // selected it would be dead code that looks load-bearing.
  const host = offPager(true);
  for (const r of [BASE, ...DELAYS, ...REDUCED]) {
    assert.equal([...host.querySelectorAll(r.sel)].some((el) => el.id === "room"), false,
      `the room-keyed box is reachable by: ${r.sel}`);
  }
});

test("the three delays land on three DIFFERENT boxes, in DOM order — that IS the stagger", () => {
  // A delay rule that selected the same element as another, or none at all,
  // leaves the panel filling in at one moment, which is the whole defect
  // the stagger exists to remove.
  const host = offPager(true);
  const hit = DELAYS.map((r) => ids(host, r.sel));
  for (const [i, h] of hit.entries()) {
    assert.equal(h.length, 1, `delay rule ${i + 1} must select exactly one box, got ${h.join()}`);
  }
  assert.deepEqual(hit.flat(), ["dir", "divider", "mem"],
    "the delays must walk the regions in DOM order");
  const delayMs = DELAYS.map((r) => Number(/animation-delay:\s*(\d+)ms/.exec(r.body)?.[1]));
  assert.deepEqual([...delayMs].sort((a, b) => a - b), delayMs, "the delays must increase");
  assert.equal(new Set(delayMs).size, 3, "three boxes with the same delay is not a stagger");
});

test("without data-entered the panel is untouched — nothing is parked mid-animation", () => {
  // The elements are visible at rest; a failed or skipped animation
  // must leave a readable panel, not an empty one.
  const host = offPager(false);
  for (const r of [BASE, ...DELAYS, ...REDUCED]) {
    assert.equal(host.querySelectorAll(r.sel).length, 0, `still reachable at rest: ${r.sel}`);
  }
});

test("under the pager skin the same rule reaches the row, which there is a real box", () => {
  const host = onPager();
  assert.deepEqual(ids(host, BASE.sel), ["scroller"],
    "on the pager the wrapper is a real box and is the thing that animates");
});

test("reduced motion cancels the entrance EVERYWHERE the entrance reaches", () => {
  // A narrower override would leave some region still animating for a viewer
  // who asked for no motion. Executed, not inferred from the two strings
  // sitting near each other in the file.
  // BOTH skins, and that is the point: off the pager the one-hop rule matches
  // nothing (the wrapper is boxless), so an override narrowed to the two-hop
  // rule alone LOOKS complete there. The pager skin is where the one-hop rule
  // has a real target, and where dropping it from the override shows up.
  for (const host of [offPager(true), onPager()]) {
    assert.deepEqual(ids(host, REDUCED[0]!.sel), ids(host, BASE.sel),
      "the reduced-motion rule must select exactly the set the animate rule selects");
  }
  assert.match(REDUCED[0]!.body, /animation:\s*none/);
  // …and it must be reached through the media query, not merely written near it.
  assert.ok(reducedBody.includes(".matrix-entrance"),
    "the override must sit INSIDE @media (prefers-reduced-motion: reduce)");
  assert.equal(/\.matrix-entrance[^{}]*\{[^{}]*animation:\s*none/.test(flat), false,
    "…and the cancel must not ALSO sit outside the media query, where it would kill the entrance for everyone");
});

// ── Vacuity anchor ───────────────────────────────────────────────────────────
// The assertions above are a mix, but four of them are NEGATIVE ("reaches
// nothing", "is not reachable"), and a negative assertion goes green over a
// hole — an empty file, a moved file, a bad join(). Anchor on the LAST rule in
// chrome.css, so the whole file provably parsed, not just its opening.
test("chrome.css was read to its END", () => {
  const raw = readFileSync(cssPath, "utf8");
  assert.match(raw.slice(-400), /matrix-entrance/,
    "the entrance is the last block in chrome.css — if it moved, re-anchor here deliberately");
  assert.ok(raw.trimEnd().endsWith("}"), "the stylesheet is truncated");
});
