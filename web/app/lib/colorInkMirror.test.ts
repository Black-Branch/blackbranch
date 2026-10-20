// The ink decision exists in TWO places, and they must agree.
//
//   • colors.ts inkOn()          — runs on hydration and on every settings change
//   • layout.tsx prepaint script — runs before first paint, inline vanilla JS
//
// They cannot share code (the prepaint script is a string in the HTML, before any
// bundle loads), so this pins the one number that could drift between them: the
// luminance at which the choice flips. Get it wrong and there is a band of
// mid-tone colours where the button's label CHANGES COLOUR on hydration — a
// flash that only appears for viewers who picked a colour in that band, which is
// exactly the kind of bug that never shows up in testing.
//
// Run: node --test app/lib/colorInkMirror.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inkOn } from "./colors.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const layout = readFileSync(join(webRoot, "app/layout.tsx"), "utf8");

const INK_DARK = "#16161a";
const INK_LIGHT = "#f4f4f5";

function lumaOf(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * lin(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * lin(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * lin(parseInt(hex.slice(5, 7), 16))
  );
}

test("the prepaint ink threshold IS inkOn's crossover", () => {
  // Where contrast(x, dark) == contrast(x, light):
  //   (x+.05)/(D+.05) == (L+.05)/(x+.05)  →  x = sqrt((D+.05)(L+.05)) - .05
  const exact = Math.sqrt((lumaOf(INK_DARK) + 0.05) * (lumaOf(INK_LIGHT) + 0.05)) - 0.05;

  const m = layout.match(/return L>([\d.]+)\?/);
  assert.ok(m, "the prepaint script's ink threshold is gone or was reshaped");
  const inScript = Number(m![1]);

  assert.ok(
    Math.abs(inScript - exact) < 1e-5,
    `prepaint uses ${inScript}, inkOn crosses over at ${exact.toFixed(6)} — ` +
    "mid-tone fills would change ink on hydration"
  );
});

test("prepaint and inkOn agree on every colour, including the boundary", () => {
  // Belt and braces: replay the script's rule and diff it against inkOn across a
  // sweep that deliberately crowds the crossover.
  const m = layout.match(/return L>([\d.]+)\?/);
  const threshold = Number(m![1]);
  const scriptInk = (hex: string) => (lumaOf(hex) > threshold ? INK_DARK : INK_LIGHT);

  const probes: string[] = [];
  for (let v = 0; v <= 255; v += 3) {
    probes.push("#" + [v, v, v].map((c) => c.toString(16).padStart(2, "0")).join(""));
  }
  // Saturated colours land at very different lumas for the same channel values.
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51)
      for (let b = 0; b <= 255; b += 51)
        probes.push("#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join(""));

  const disagreements = probes.filter((p) => scriptInk(p) !== inkOn(p));
  assert.equal(
    disagreements.length,
    0,
    `${disagreements.length} colours flip ink between prepaint and hydration: ${disagreements.slice(0, 6).join(", ")}`
  );
});

test("both ink constants still exist in colors.ts", () => {
  // The threshold above is derived from these two values. If someone retunes an
  // ink without retuning the prepaint number, the first test's `exact` moves and
  // catches it — but only while the inks are really these.
  const src = readFileSync(join(webRoot, "app/lib/colors.ts"), "utf8");
  assert.ok(src.includes(INK_DARK), `colors.ts no longer defines ${INK_DARK}`);
  assert.ok(src.includes(INK_LIGHT), `colors.ts no longer defines ${INK_LIGHT}`);
});
