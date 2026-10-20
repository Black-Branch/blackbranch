// The store's style tiles may bound their overflow, but not below what the
// styles actually paint.
//
// A style tile cannot use `overflow: hidden` — that clips the text-shadow halos
// and the wobble rotation, and those ARE the styles: clipped, glow, pulse and
// emboss render identically to a plain name, so the tile stops previewing
// anything. Left unbounded, though, a name wider than its third of the grid
// paints over the two tiles beside it.
//
// `overflow-x: clip` with an `overflow-clip-margin` is the settlement, and it is
// only correct while the margin is at least as wide as the widest halo any
// equipped style can emit. That number lives in three files that nobody edits
// together — a new effect with a bigger glow, or a tweak to --chat-shadow, would
// silently start clipping the thing the margin exists to protect.
//
// So the margin is not asserted against a copy of itself. The maximum is
// RE-DERIVED here from the source of every shadow that can land on a previewed
// name, and the constant must cover it — derived from the terms that produce
// it rather than eyeballing a value that looked right.
//
// Run: node --test app/lib/storeStylePreview.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = join(appDir, "features/store/StoreSpend.tsx");
const STYLES = join(appDir, "lib/usernameStyles.ts");
const CSS = join(appDir, "globals.css");

// Comments out first. This file's own header quotes `0 0 13px`, and so does
// the constant's docblock in StoreSpend — a scan that read comments would be
// measuring the documentation instead of the code.
const readTs = (p: string) => stripComments(readFileSync(p, "utf8"));

/**
 * Every blur radius in a `text-shadow`-shaped triple in `src`, in px.
 *
 * Matches `<x> <y> <blur>` where all three are px lengths — the shape every
 * shadow layer in these files is written in. Colours and later layers are
 * irrelevant; only how far the paint reaches.
 */
function blurRadii(src: string): number[] {
  const out: number[] = [];
  // Every length may be a bare `0` — CSS allows a unitless zero, and these are
  // written that way at both ends: glow is `0 0 13px …` and emboss is
  // `-1px -1px 0 …`. Requiring `px` on the blur silently dropped emboss's two
  // layers, which made the layer count look like the extraction was broken.
  // The blur is the third length and the only one that matters.
  const len = String.raw`-?\d+(?:\.\d+)?(?:px)?`;
  const re = new RegExp(`${len}\\s+${len}\\s+(\\d+(?:\\.\\d+)?)(?:px)?`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(Number(m[1]));
  return out;
}

/**
 * The shadow layers an EFFECT emits, as written in `usernameStyles.ts`.
 *
 * Scoped to the `shadow.push(…)` calls rather than the whole file, so a stray
 * number triple elsewhere in a 700-line module cannot inflate the maximum and
 * demand a margin nothing actually needs.
 */
function effectShadows(src: string): number[] {
  const out: number[] = [];
  const re = /shadow\.push\(([^;]*?)\);/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(...blurRadii(m[1]!));
  return out;
}

/** The bound the store tile declares. */
function declaredMargin(): number {
  const m = /const HALO_CLIP_MARGIN = (\d+)/.exec(readTs(STORE));
  assert.ok(m, "StoreSpend no longer declares HALO_CLIP_MARGIN");
  return Number(m[1]);
}

test("the effect halos were actually measured", () => {
  // The vacuity anchor. The real assertion below has the form "the declared
  // margin covers the measured maximum", and a maximum measured from an empty
  // read is -Infinity — which every margin covers. So the measurement itself is
  // what has to be checked first, and positively.
  const fromStyles = effectShadows(readTs(STYLES));
  const fromCss = pulseShadows();
  assert.ok(
    fromStyles.length >= 4,
    `expected several effect shadow layers in usernameStyles.ts, measured ${fromStyles.length}`
  );
  assert.ok(
    fromCss.length >= 2,
    `expected the un-pulse keyframes to carry shadows, measured ${fromCss.length}`
  );
  // The glow bloom is the widest layer and the reason the margin is what it is.
  // Named explicitly so shrinking it is a decision someone makes here, rather
  // than a number that quietly drifts down and leaves the margin oversized.
  assert.ok(
    Math.max(...fromStyles) >= 13,
    "the glow bloom shrank — re-derive HALO_CLIP_MARGIN rather than leaving it oversized"
  );
});

/**
 * The pulse effect's halo, from its keyframes.
 *
 * `--chat-shadow` is NOT read here, on purpose. Its wide layer follows the
 * user's blur slider (12px default, up to 36px — `shadowSpec` in
 * settingsRegistry.ts), so no fixed margin could contain it, and it is the same
 * lift under every style — clipping it costs no information about WHICH style a
 * tile is showing. The effect halos are the thing the margin exists for.
 */
function pulseShadows(): number[] {
  const css = stripCssComments(readFileSync(CSS, "utf8"));
  const pulse = /@keyframes un-pulse\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(pulse, "globals.css no longer defines the un-pulse keyframes");
  return blurRadii(pulse[1]!);
}

test("HALO_CLIP_MARGIN covers the widest halo an effect can paint", () => {
  const widest = Math.max(...effectShadows(readTs(STYLES)), ...pulseShadows());
  assert.ok(widest > 0, "measured no halo at all — the extraction is broken");
  assert.ok(
    declaredMargin() >= widest,
    `HALO_CLIP_MARGIN is ${declaredMargin()}px but an effect paints out to ${widest}px — ` +
      "the tile would clip the halo it exists to show"
  );
});

test("the tile clips on one axis only, and never with overflow-hidden", () => {
  const src = readTs(STORE);
  assert.ok(
    src.includes("overflow-x-clip") && src.includes("overflow-y-visible"),
    "the style tile no longer clips horizontally while staying visible vertically"
  );
  assert.ok(
    src.includes("overflowClipMargin"),
    "the style tile clips with no margin — the halos go with it"
  );
});

test("the preview row zooms rather than transform-scales", () => {
  // `transform: scale()` does not change the layout box, so the row would
  // report no overflow and a long name would spill out of it — the very bug
  // the row was added to fix, moved one element up the page.
  const src = readTs(STORE);
  const row = /min-h-14[\s\S]{0,600}?<\/div>/.exec(src);
  assert.ok(row, "the full-width preview row is gone");
  // The zoom is FITTED by StyledName (`fit`, up to 1.35×) — still zoom, never
  // transform (profileCardParts.tsx sets el.style.zoom).
  assert.ok(/fit=\{1\.35\}/.test(row[0]), "the preview row no longer zooms");
  assert.ok(
    !/scale-\d|transform:\s*scale/.test(row[0]),
    "the preview row uses transform scale, which leaves its layout box unscaled"
  );
  // A long name is shrunk to fit, not scrolled: scrolling clips the tall faces
  // top and bottom (overflow-x forces overflow-y), cutting names off in the
  // previews.
  assert.ok(!row[0].includes("overflow-x-auto"), "the preview row scrolls again, and clips tall faces");
});
