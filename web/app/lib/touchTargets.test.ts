// Fingertip-sized targets on coarse pointers.
//
// A coarse-pointer target must actually reach 44px (not 40), and must cover
// every tap-only control on the surfaces phones see most — not just
// `.row-actions button`.
//
// The two nudge dismiss ✕s cannot simply grow: they sit in measured rows. So
// they keep their visual box and get `.tap-hit-44` — a centered 44×44
// pseudo-element that participates in the button's OWN hit test without
// costing a pixel of layout, and only where a coarse pointer exists.
//
// Run: node --test app/lib/touchTargets.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function readWhole(path: string, tailAnchor: RegExp, strip: (s: string) => string): string {
  const src = readFileSync(join(webRoot, path), "utf8");
  assert.match(
    src.slice(-400), tailAnchor,
    `${path} did not end as expected — the read is truncated, and every assertion below it is vacuous`,
  );
  return strip(src);
}

const CSS_TAIL = /timer-delta-fade[\s\S]*}\s*$/;

test("row-actions buttons meet the guideline their own rule cites", () => {
  const css = readWhole("app/globals.css", CSS_TAIL, stripCssComments);
  assert.match(css, /\.row-actions button\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;\s*\}/,
    "the coarse-pointer row-actions minimum slid off 44px — the rule's comment cites the 44px " +
    "guideline; it shipped at 40 for a week because nothing held the number");
});

test("the borrowed-hit-area class exists, coarse-only, 44px, non-displacing", () => {
  const css = readWhole("app/globals.css", CSS_TAIL, stripCssComments);
  assert.match(css, /\.tap-hit-44\s*\{\s*position:\s*relative;\s*\}/, ".tap-hit-44 lost its positioning context");
  assert.match(css, /\.tap-hit-44::after\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*\}/,
    ".tap-hit-44's pseudo-element no longer spans 44×44");
  // Inside the coarse gate: on a fine pointer the enlarged hit area would
  // swallow clicks meant for neighbours a mouse can actually aim between.
  const coarseStart = css.indexOf("@media (pointer: coarse)");
  const tapHit = css.indexOf(".tap-hit-44");
  assert.ok(coarseStart !== -1 && tapHit > coarseStart,
    ".tap-hit-44 moved outside (or before) the coarse-pointer gate");
});

test("the two undersized controls wear it", () => {
  for (const [file, tail] of [
    ["app/components/PwaInstallNudge.tsx", /aria-label="Dismiss">\s*✕\s*<\/button>\s*<\/div>\s*<\/div>\s*\)\s*;\s*}\s*$/],
    ["app/components/MatrixAppsHint.tsx", /<MatrixAppsList \/>\s*<\/div>\s*\)\s*}\s*<\/div>\s*<\/div>\s*\)\s*;\s*}\s*$/],
  ] as const) {
    const src = readWhole(file, tail, stripComments);
    assert.match(src, /aria-label="Dismiss"[\s\S]{0,40}✕|tap-hit-44[^"]*"[^>]*aria-label="Dismiss"/,
      `${file}: dismiss button structure changed — update this scan`);
    assert.match(src, /tap-hit-44/, `${file}: the dismiss ✕ (~20px) lost its borrowed hit area`);
  }
});
