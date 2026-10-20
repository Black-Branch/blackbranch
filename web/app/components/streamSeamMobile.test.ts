// Pins the mobile video/chat seam.
//
// WHAT THE SEAM IS. On phones the video column and the chat/tabs panel meet
// edge-to-edge with no gap, so the only thing telling a viewer they are two
// layers is the video frame's bottom border plus a shadow cast down onto the
// chat below it.
//
// WHY THE SHADOW IS A PSEUDO-ELEMENT AND NOT THE FRAME'S OWN box-shadow. Both
// panels already carry the panel float shadow (`--panel-shadow`, globals.css),
// whose layers are all offset downward, so the code reads as though that does
// the separating.
// It does not: the whole chat side paints ABOVE the video column, because every
// Bar is `position: relative; z-index: 10` (chrome.css) and the scroll layer
// carries `transform: translateZ(0)` (the hairline-shimmer mitigation), every
// one of which is a stacking context later in tree order than the column.
// At 390px, a 40px OPAQUE spread shadow on the frame puts zero pixels over the
// chat surface — only over the page gutters beside it. So the frame can never
// cast onto chat without a z-index that outranks a Bar's 10.
//
// The column's own `::after` gets that z-index instead of the frame, which
// keeps three separate things true, each of which is a real trap:
//   1. the frame carries `overflow-hidden`, which would clip a ::after of its
//      own before it ever reached the chat panel;
//   2. the frame keeps `z-index: auto`, so no new stacking context traps the
//      player's own overlays (the video bars are Bars: z 10 in flow, 30 as
//      overlays);
//   3. full-screen community mode collapses the column to `height: 0;
//      overflow: hidden; opacity: 0`, which hides the seam for free.
//
// The shade itself is shared with the tab bar and the Matrix panel header
// (`--seam-shade` / `--seam-shade-box`), which is why the last test here
// guards all three together.
//
// AND WHY THE TOP BORDER IS NOT AN INLINE STYLE. An inline
// `borderTopWidth: narrow ? 0 : …` beats every cascade layer AND every media
// query, so no stylesheet could correct it; worse, `useNarrowViewport`
// snapshots false during SSR, so phones would paint a second hairline 2px
// under the first until hydration. The width lives on `.bb-chat-panel` in
// globals.css where the `max-width: 767px` block can zero it before first paint.
//
// Run: node --test app/components/streamSeamMobile.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripCssComments } from "../lib/testSource.ts";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// globals.css documents its own traps at length, and those comments quote the
// selectors and the superseded shadow value verbatim. Matching against the raw
// file therefore finds PROSE — which is how the first draft of this guard
// managed to fail against a correct stylesheet. Every assertion below reads
// declarations only.
//
// `stripCssComments` from the shared helper, NOT a local block-comment regex:
// sixteen diverging private copies is how this last went wrong, and
// testSource.test.ts refuses a new one anywhere under app/.
const readCss = () => stripCssComments(read("app", "globals.css"));

// The one `@media (max-width: 767px)` block that owns the seam. Brace-matched
// rather than regex-slurped, because the block contains nested rules.
function seamBlock(css: string): string {
  const at = css.indexOf(".bb-video-col::after");
  assert.ok(at !== -1, "no `.bb-video-col::after` rule in globals.css — the mobile seam shadow is gone");
  const open = css.lastIndexOf("@media", at);
  assert.ok(open !== -1, "`.bb-video-col::after` is no longer inside an @media block — it would apply on desktop too");
  const head = css.slice(open, css.indexOf("{", open));
  assert.match(head, /max-width:\s*767px/,
    "the seam block is not scoped to `max-width: 767px` — desktop has a resize handle and a gap, " +
    "it must not get the phone seam");
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open, i + 1);
  }
  assert.fail("unbalanced braces in the seam @media block");
}

test("the seam shadow is drawn by the column's ::after, not by the frame", () => {
  const block = seamBlock(readCss());

  assert.match(block, /\.bb-video-col\s*\{[^}]*position:\s*relative/,
    "`.bb-video-col` lost `position: relative` — its absolutely positioned ::after would " +
    "then anchor to the viewport instead of the column's bottom edge");
  assert.match(block, /\.bb-video-col::after\s*\{[^}]*content:/,
    "the seam ::after has no `content`, so no box is generated at all");
  assert.match(block, /\.bb-video-col::after\s*\{[^}]*position:\s*absolute/,
    "the seam ::after is no longer absolutely positioned — it would take part in the column's " +
    "flex flow and push the video up");
  assert.match(block, /\.bb-video-col::after\s*\{[^}]*pointer-events:\s*none/,
    "the seam ::after must stay `pointer-events: none` — it sits over the chat tab bar's top edge");
});

test("the seam outranks the chat tab bar it is cast onto", () => {
  const css = readCss();
  const block = seamBlock(css);

  const seamZ = block.match(/\.bb-video-col::after\s*\{[^}]*?z-index:\s*(\d+)/);
  assert.ok(seamZ?.[1], "the seam ::after sets no z-index — the chat side's stacking contexts " +
    "(a Bar's z-index:10, plus the translateZ(0) compositing layers) would paint over it " +
    "and the seam would be invisible");

  const chrome = stripCssComments(readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8"));
  const barZ = chrome.match(/\.chrome-bar\s*\{[^}]*?z-index:\s*(\d+)/);
  assert.ok(barZ?.[1], "couldn't read .chrome-bar's z-index — update this guard if the rule moved");

  assert.ok(Number(seamZ[1]) > Number(barZ[1]),
    `the seam's z-index (${seamZ[1]}) must stay above the chat tab bar's (${barZ[1]}); the tab bar ` +
    "sits directly under the seam, so a tie or a lower value hides the shadow completely");
});

test("the chat panel's top border is stylesheet-owned, never inline", () => {
  const css = readCss();
  const tsx = read("app", "components", "StreamView.tsx");

  assert.match(css, /\.bb-chat-panel\s*\{\s*border-top-width:\s*var\(--frame-width/,
    "the desktop `.bb-chat-panel { border-top-width: var(--frame-width, …) }` rule is gone — " +
    "with the inline value removed, the panel would fall back to Tailwind preflight's 0 and lose " +
    "its top border on desktop");
  assert.match(seamBlock(css), /\.bb-chat-panel\s*\{[^}]*border-top-width:\s*0/,
    "the phone override that zeroes the chat panel's top border is gone — the seam would show a " +
    "second hairline 2px below the video frame's");

  assert.match(tsx, /className=\{`bb-panel bb-chat-panel /,
    "the chat panel no longer carries `bb-chat-panel`, so neither border-width rule can reach it");
  assert.doesNotMatch(tsx, /borderTopWidth\s*:/,
    "StreamView sets `borderTopWidth` inline again — an inline declaration beats both the media " +
    "query and every cascade layer, and `useNarrowViewport` is false during SSR, so phones would paint " +
    "a doubled hairline until hydration");
});

test("nothing is added inside the video frame to draw the seam", () => {
  const css = readCss();
  assert.doesNotMatch(css, /\.player-attached::after|\.player-fill::after|\.player-radio::after/,
    "a seam pseudo-element appeared on a frame-level class — the frame carries `overflow-hidden`, " +
    "so it would be clipped before reaching the chat panel");
});

// The shade is user-controllable (`seamOn`/`seamStrength`/`seamDepth`), which
// makes the CSS defaults and the TypeScript spec two statements of the same
// numbers — and a silent drift between them has a nasty shape: the page loads
// looking one way, the user nudges a slider back to 1.0, and it settles
// looking another. Neither value is "wrong" on its own, so nothing would ever
// flag it. This pins them together.
test("globals' :root shade IS seamSpec(1, 1)", () => {
  const css = readCss();
  const reg = read("app", "lib", "settingsRegistry.ts");

  const base = reg.match(/const SEAM_BASE = \{([^}]*)\}/)?.[1];
  assert.ok(base, "SEAM_BASE is gone from settingsRegistry.ts — the sliders have no spec to scale");
  const num = (k: string) => {
    const m = base.match(new RegExp(`\\b${k}:\\s*(-?[\\d.]+)`))?.[1];
    assert.ok(m, `SEAM_BASE lost its \`${k}\``);
    return m;
  };

  const h = css.match(/--seam-shade-h:\s*([\d.]+)px/)?.[1];
  assert.ok(h, "globals.css lost --seam-shade-h");
  assert.equal(h, num("h"),
    `--seam-shade-h (${h}px) and SEAM_BASE.h (${num("h")}) disagree — at strength/depth 1 the ` +
    "stylesheet and the slider must render the same seam");

  const grad = css.match(/--seam-shade:\s*linear-gradient\([\s\S]*?\);/)?.[0];
  assert.ok(grad, "globals.css lost the --seam-shade gradient");
  assert.ok(grad.includes(`rgba(0, 0, 0, ${num("a1")})`),
    `the gradient's first stop no longer matches SEAM_BASE.a1 (${num("a1")})`);
  assert.ok(grad.includes(`rgba(0, 0, 0, ${num("a2")})`),
    `the gradient's mid stop no longer matches SEAM_BASE.a2 (${num("a2")})`);

  const box = css.match(/--seam-shade-box:\s*([^;]+);/)?.[1];
  assert.ok(box, "globals.css lost --seam-shade-box");
  assert.equal(box.trim(), `0 ${num("y")}px ${num("blur")}px ${num("spread")}px rgba(0, 0, 0, ${num("a")})`,
    "--seam-shade-box is no longer what seamSpec(1, 1) produces from SEAM_BASE");
});

test("the shade's three controls are registered, mirrored and reachable", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  const menu = read("app", "lib", "settingsMenu.ts");
  const layout = read("app", "layout.tsx");

  for (const key of ["seamOn", "seamStrength", "seamDepth"]) {
    assert.match(reg, new RegExp(`\\b${key}:\\s*E\\(\\{[^}]*prePaint: true`),
      `${key} is missing or is no longer prePaint — the shade would pop in after first paint`);
    assert.ok(menu.includes(`s("${key}"`),
      `${key} is in the registry but not in settingsMenu — an orphan setting nobody can reach`);
  }
  // check-prepaint proves the keys are READ before paint; this proves they are
  // read into the right custom properties.
  for (const prop of ["--seam-shade", "--seam-shade-box"]) {
    assert.ok(layout.includes(`'${prop}'`),
      `the pre-paint script no longer sets ${prop}`);
  }
});

// Every "a layer ends here, chat begins below it" boundary uses one shade. A
// phone shows the video seam, the tab bar and (on the Matrix tab) the panel
// header within ~40px of each other, so any of them drifting to its own depth
// reads as a mistake. The two forms exist because neither works in both
// geometries — see the --seam-shade note in globals.css.
test("every chat-surface boundary draws the one shared shade", () => {
  const css = readCss();

  assert.match(css, /--seam-shade:\s*linear-gradient/,
    "`--seam-shade` (the gradient form, used by the mobile seam) is gone");
  assert.match(css, /--seam-shade-box:\s*[^;]+;/,
    "`--seam-shade-box` (the box-shadow form, used by the bars) is gone");

  const block = seamBlock(css);
  assert.match(block, /\.bb-video-col::after\s*\{[^}]*background:\s*var\(--seam-shade\)/,
    "the mobile seam stopped using `var(--seam-shade)` — it would drift away from the tab bar's depth");

  const chrome = stripCssComments(readFileSync(join(process.cwd(), "app", "components", "chrome", "chrome.css"), "utf8"));
  assert.match(chrome, /\.chrome-bar-top\[data-seam\]\s*\{[^}]*box-shadow:\s*var\(--seam-shade-box\)/,
    "top Bars no longer draw `var(--seam-shade-box)`; the chat tab bar AND the Matrix panel headers " +
    "(top Bars) are both boundaries that have to match the video seam");

  assert.doesNotMatch(css, /box-shadow:\s*0 8px 16px -8px/,
    "the pre-normalization separator value `0 8px 16px -8px rgba(0,0,0,0.7)` is back in globals.css — " +
    "it measures about half the depth of --seam-shade-box, so whichever surface carries it will read " +
    "as a shallower boundary beside the others");
});
