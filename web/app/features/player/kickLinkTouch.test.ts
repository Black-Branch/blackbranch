// The player card's "Watch on Kick" link: a pill measured 32px tall at 390px
// (text-sm's 20px line + py-1.5), below the 44px a thumb needs. It borrows a
// full-width, 44px-tall hit area on touch (globals.css .tap-hit-tall) instead
// of growing, so the pill looks exactly as before.
//
// The box arithmetic below is the derivation; the Look (look/05-targets.mjs)
// measures the real link with elementFromPoint 21px above and below centre.
//
// Run: node --test app/features/player/kickLinkTouch.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments, stripCssComments, cssAtRuleBodies } from "../../lib/testSource.ts";

const area = stripComments(readFileSync(new URL("./StreamPlayerArea.tsx", import.meta.url), "utf8"));
const css = stripCssComments(readFileSync(new URL("../../globals.css", import.meta.url), "utf8"));

const link = /<a\b[^>]*>\s*Watch on Kick\s*<\/a>/.exec(area);

test("the Watch on Kick pill keeps its look and borrows the tall hit area", () => {
  assert.ok(link, "the card's Kick link is found");
  const cls = /className="([^"]+)"/.exec(link[0])?.[1] ?? "";
  // The look: unchanged pill.
  for (const c of ["rounded-md", "bg-surface-2", "px-3", "py-1.5"]) assert.ok(cls.split(" ").includes(c), c);
  assert.ok(cls.split(" ").includes("tap-hit-tall"), "the borrowed 44px hit area");
});

test("tap-hit-tall: coarse pointers only, the pill's full width, 44px tall, centred", () => {
  const bodies = cssAtRuleBodies(css, "@media (pointer: coarse)");
  const coarse = bodies.join("\n");
  const rel = /\.tap-hit-tall \{ position: relative; \}/.test(coarse);
  assert.ok(rel, "the pseudo-element is positioned against the link");
  const after = /\.tap-hit-tall::after \{([^}]*)\}/.exec(coarse);
  assert.ok(after, "the area exists, inside a coarse-pointer block");
  const decl = after[1] ?? "";
  assert.match(decl, /content: "";/);
  assert.match(decl, /position: absolute;/);
  assert.match(decl, /left: 0;/);
  assert.match(decl, /right: 0;/);
  assert.match(decl, /top: 50%;/);
  assert.match(decl, /transform: translateY\(-50%\);/);
  const h = /height: (\d+)px;/.exec(decl);
  assert.ok(h, "a fixed height");
  // The derivation: the pill is 20px (text-sm line) + 2 × 6px (py-1.5) = 32px;
  // the area must reach 44 whatever the pill is.
  assert.ok(Number(h[1]) >= 44, `hit area ${h[1]}px ≥ 44px`);
  assert.ok(Number(h[1]) > 20 + 2 * 6, "taller than the pill it serves");
  const fine = bodies.reduce((rest, b) => rest.replace(b, ""), css);
  assert.equal(/\.tap-hit-tall/.test(fine), false, "never on a fine pointer, where it would swallow clicks");
});

test("vacuity: the player area was read to its end", () => {
  assert.match(area, /\}\s*$/);
  assert.ok(area.length > 5000);
});
