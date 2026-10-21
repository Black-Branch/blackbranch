import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stripComments } from "./testSource.ts";

const RAW = readFileSync(new URL("../components/StreamMetaBar.tsx", import.meta.url), "utf8");
assert.match(RAW.slice(-300), /\/>\s*\);\s*\}\s*$/, "vacuity anchor: StreamMetaBar ends with the Bar's close");
const src = stripComments(RAW);

test("the money actions are three in-flow circles plus the featured Visit-channel link; the title yields the space", () => {
  assert.doesNotMatch(src, /ACTIONS_W/, "the fixed-width box constant is gone — the actions row sizes itself in flow");
  assert.equal((src.match(/className=\{moneyCircle\(/g) ?? []).length, 4);
  assert.match(src, /className="flex items-center gap-1\.5 shrink-0 h-\[28px\]"/,
    "the actions container is a normal in-flow flex row, not a fixed-width absolutely-positioned box");
  assert.doesNotMatch(src, /@container\/bar|@\[780px\]|--bar-actions|flex-2|flex-3|metaBarLayout/);
  assert.doesNotMatch(src, /className="pill/);
});

test("a resting circle is 28 wide: no gap- inside moneyCircle, the label's spacing inside its clip", () => {
  // `gap-1.5` on the circle applied to the label span, which is a flex item at
  // zero width too — so every RESTING circle came out 8+13+6+8 = 35 wide. The
  // spacing moved inside the label's own overflow-hidden clip, where max-w-0
  // actually suppresses it (padding on the clip would not have been:
  // border-box floors the CONTENT box at 0, not the padding).
  const box = src.match(/const moneyCircle = \(skin: string\) =>\s*`([^`]*)`/)?.[1] ?? "";
  assert.ok(box, "moneyCircle's template string is gone or reshaped");
  assert.doesNotMatch(box, /\bgap-/, "a gap inside moneyCircle is 6px of resting width the 28px budget does not have");
  assert.match(box, /\$\{skin\}/, "the padding must come from the per-call `skin` argument, not be baked into the shared template — a border eats into the same 28px budget");
  assert.match(src, /const moneyLabel = "[^"]*pl-1\.5[^"]*";/,
    "the icon-to-label spacing must live on the clipped label, not on the circle");
});

test("one flat shape: 28px circles, no gloss, no border, the same 7.5px pad", () => {
  // A flat bordered points circle beside two glossy ones is a mismatch, and so is
  // a gloss nothing else on the site uses. All four share 7.5 + 13 + 7.5 = 28.
  const box = src.match(/const moneyCircle = \(skin: string\) =>\s*`([^`]*)`/)?.[1] ?? "";
  assert.match(box, /\bh-\[28px\] min-w-\[28px\] rounded-full\b/);
  assert.match(box, /\bmoney-hit\b/, "a fingertip tap area on touch (globals.css)");
  assert.match(box, /active:scale-\[\.92\]/, "the shared press dip");
  assert.equal((src.match(/moneyCircle\("px-\[7\.5px\]/g) ?? []).length, 4);
  assert.doesNotMatch(src, /glossy\(/, "no gloss on the money buttons");
  assert.doesNotMatch(src, /moneyCircle\("[^"]*\bborder\b/, "no bordered circle");
  assert.match(src, /moneyCircle\("px-\[7\.5px\] bg-surface-2 text-body-dim hover:text-strong hover:bg-surface-3"\)/, "Qorm is the neutral one");
  assert.match(src, /style=\{\{ backgroundColor: "var\(--donate-color\)", color: "var\(--donate-ink, var\(--color-on-accent\)\)" \}\}/);
  assert.match(src, /style=\{\{ backgroundColor: "var\(--gift-color\)", color: "var\(--gift-ink, var\(--color-on-accent\)\)" \}\}/);
  const css = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.money-hit::after \{ content: ""; position: absolute; inset: -8px -3px; \}\s*\}/,
    "44px tall, and wide only to half the 6px gap — neighbours' tap areas touch, never overlap");
});

test("grows on hover in flow — the neighbours shift, the title yields", () => {
  assert.match(src, /group-hover\/money:max-w-\[7rem\]/);
  assert.match(src, /group-focus-visible\/money:max-w-\[7rem\]/);
  assert.match(src, /transition-\[max-width,opacity\]/);
  assert.match(src, /const moneyLabel = "block pl-1\.5";/);
  assert.match(src, /className="flex items-center gap-1\.5 shrink-0 h-\[28px\]"/,
    "the actions row must gap its circles, not the removed fixed-width box");
  const box = src.match(/const moneyCircle = \(skin: string\) =>\s*`([^`]*)`/)?.[1] ?? "";
  assert.ok(box, "moneyCircle's template string is gone or reshaped");
  assert.doesNotMatch(box, /\babsolute\b/,
    "a circle positioned absolutely can grow OVER its neighbour instead of moving it");
});

test("the meta line is stream facts only — About and Privacy left it", () => {
  assert.doesNotMatch(src, /\/about|legal#privacy/);
});

test("the 780px layout and its measured terms are gone, not orphaned", () => {
  assert.equal(existsSync(new URL("./metaBarLayout.ts", import.meta.url)), false);
  assert.equal(existsSync(new URL("./supportActionsWidth.test.ts", import.meta.url)), false);
});

// ── four guards that are not about the bar's geometry, pinned against the
//    fixed-circle mechanism ──────────────────────────────────────────────────────

test("the meter is gone from the site bar: no SupportMeterPill import, no --meter-w", () => {
  // The support meter is not on the SITE bar — OBS has it
  // (`stream-api/meter.js` broadcasts `meterState`, OBS `meter.html`
  // renders it). END-anchored above (RAW proven whole, not truncated) and
  // comment-stripped (src), so a surviving mention in prose cannot save either.
  assert.doesNotMatch(src, /SupportMeterPill/, "the deleted pill is still imported or rendered");
  assert.doesNotMatch(src, /--meter-w/, "the meter's narrow/wide custom property is still set");
});

test("the money buttons do NOT stretch to fill the bar", () => {
  // The circles guarantee "do not stretch" in flow: shrink-0 keeps them
  // off the row's shrink budget, min-w-[28px] pins their resting floor, and
  // nothing here participates in flex-grow.
  const box = src.match(/const moneyCircle = \(skin: string\) =>\s*`([^`]*)`/)?.[1] ?? "";
  assert.ok(box, "moneyCircle's template string is gone or reshaped");
  assert.match(box, /\bshrink-0\b/, "a money circle without shrink-0 can be squeezed by the title");
  assert.match(box, /\bmin-w-\[28px\]/, "a money circle needs its 28px resting floor pinned");
  assert.doesNotMatch(box, /flex-auto|flex-grow|\bflex-1\b|\bgrow\b(?!-0)/, "a money button grows again beyond its labelled pill");
});

test("one row: no caret, no expanded state, no second row", () => {
  assert.doesNotMatch(src, /CaretDown|expanded|showMeta|forceCollapsed|collapse-row|aria-expanded/);
  assert.match(src, /<Bar\s+slot="bottom"\s+name="video-bottom"\s+overlay=\{overlay\}\s+hidden=\{hidden\}/);
});

test("the secondary line must truncate, never wrap", () => {
  // The meta line ELLIPSIZES rather than wrapping into a row the bar does not
  // have — and `text-overflow` only runs on a block box's own inline content, so
  // the line must not be a flex container (one hard-clips mid-glyph, and the
  // ellipsis never runs).
  assert.match(src, /className="mt-0\.5 text-xs text-secondary whitespace-nowrap truncate"/,
    "the secondary line must truncate, never wrap");
  assert.doesNotMatch(src, /flex[^"]*whitespace-nowrap truncate/,
    "an ellipsis needs a block container — text-overflow never runs on a flex box");
  assert.doesNotMatch(src, /flex-wrap/, "a wrapping meta line would overflow a 48px bar");
});
