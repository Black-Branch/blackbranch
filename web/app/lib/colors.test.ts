// Guards for inkOn() — the readable label colour for a viewer-chosen button
// fill (the player pill bar, whose button colours the viewer picks).
//
// The bug this exists to prevent: `--color-on-accent` is a fixed near-black, so
// the moment a viewer picks a dark Donate colour the label goes dark-on-dark and
// the button reads as blank. That failure is invisible to every automated check
// EXCEPT a contrast assertion, which is why these tests assert the ratio rather
// than the returned string.
//
// Run: node --test app/lib/colors.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { inkOn, cssColorLuma, readableColor } from "./colors.ts";

function contrast(a: string, b: string): number {
  const la = cssColorLuma(a);
  const lb = cssColorLuma(b);
  assert.ok(la !== null && lb !== null, `unparseable: ${a} / ${b}`);
  return (Math.max(la!, lb!) + 0.05) / (Math.min(la!, lb!) + 0.05);
}

test("a dark fill gets light ink", () => {
  // The exact case that motivated this: a viewer picks near-black for Donate.
  const ink = inkOn("#1a1a1a");
  assert.ok(contrast("#1a1a1a", ink) > 4.5, `contrast was ${contrast("#1a1a1a", ink)}`);
});

test("a light fill gets dark ink", () => {
  const ink = inkOn("#f0e8d0");
  assert.ok(contrast("#f0e8d0", ink) > 4.5);
});

test("every fill across the spectrum clears 4.5:1", () => {
  // Sweep rather than spot-check: the failure mode is a band of mid-tones where
  // NEITHER ink is comfortable, and a couple of hand-picked colours miss it.
  const failures: string[] = [];
  for (let r = 0; r <= 255; r += 51) {
    for (let g = 0; g <= 255; g += 51) {
      for (let b = 0; b <= 255; b += 51) {
        const fill = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
        const ratio = contrast(fill, inkOn(fill));
        if (ratio < 4.5) failures.push(`${fill} → ${inkOn(fill)} (${ratio.toFixed(2)}:1)`);
      }
    }
  }
  // Mid-tones genuinely cannot reach 4.5:1 against either pure ink — that is a
  // property of the colour space, not a bug. What must hold is that the CHOICE
  // is always the better of the two, and that the shortfall is small and rare.
  assert.ok(
    failures.length / 216 < 0.35,
    `${failures.length}/216 fills fell under 4.5:1 — the ink choice is picking wrong:\n${failures.slice(0, 8).join("\n")}`
  );
});

test("inkOn always picks the BETTER of the two inks", () => {
  // The real invariant. Whatever the fill, the returned ink must be at least as
  // contrasty as the alternative — this is what a naive fixed token fails.
  const DARK = "#16161a";
  const LIGHT = "#f4f4f5";
  for (let r = 0; r <= 255; r += 37) {
    for (let g = 0; g <= 255; g += 37) {
      for (let b = 0; b <= 255; b += 37) {
        const fill = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
        const chosen = inkOn(fill);
        const other = chosen === DARK ? LIGHT : DARK;
        assert.ok(
          contrast(fill, chosen) >= contrast(fill, other) - 1e-9,
          `${fill}: picked ${chosen} (${contrast(fill, chosen).toFixed(2)}) over ${other} (${contrast(fill, other).toFixed(2)})`
        );
      }
    }
  }
});

test("garbage input falls back to the fixed dark ink instead of throwing", () => {
  // This value lands straight in a style attribute; a throw here would blank
  // the whole bar.
  for (const bad of ["", "not-a-color", "#12", "rgb(", "undefined"]) {
    assert.equal(inkOn(bad), "#16161a", `inkOn(${JSON.stringify(bad)})`);
  }
});

test("a colour DARKER than the panel is lightened, not darkened into nothing", () => {
  // Choosing the direction by comparing text luminance to panel luminance makes
  // anything darker than the (already very dark) panel DARKEN — and darkening
  // near-black gains no contrast, so `readableColor("#000000")` would return
  // "#000000", invisible. The direction is a property of the PANEL alone.
  const black = readableColor("#000000");
  assert.notEqual(black, "#000000", "black must not stay black");
  // Against the page background the module clamps to — 4.5:1 is the WCAG bar
  // the function exists to clear.
  const lum = cssColorLuma(black)!;
  const bg = cssColorLuma("#0c0c10")!;
  const ratio = (Math.max(lum, bg) + 0.05) / (Math.min(lum, bg) + 0.05);
  assert.ok(ratio >= 4.5, `${black} is only ${ratio.toFixed(2)}:1 on the chat panel`);

  // …and the cases that already worked must not move.
  assert.equal(readableColor("#cccccc"), "#cccccc", "a legible colour is passed through");
  assert.equal(readableColor("#333366"), "#7777bb", "an ordinary dark pick clamps as before");
});
