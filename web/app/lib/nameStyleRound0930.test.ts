// A name-style round: 12 fonts, 13 effects, and the styles nobody wears taken
// off sale — owners keep them.
// Run: node --test app/lib/nameStyleRound0930.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { USERNAME_STYLES, styleById, usernameStyleCSS, usernameStyleAnimClass, forSale } from "./usernameStyles.ts";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
const css = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
const S = (x: object) => x as Record<string, string | undefined>;

const NEW_FONTS = ["scrawl", "crafty", "friendly", "brush", "cursive", "rounded", "quirky", "spray", "fantasy", "calligraphy", "notched", "jersey"];
const NEW_EFFECTS = ["outline", "thick", "longshadow", "block", "slant", "split", "squiggle", "flicker", "glitch", "drift"];
// Shipped as effects; they have their own "entrance" category.
const NEW_ENTRANCES = ["typein", "focusin", "stamp"];
const RETIRED = ["western", "horror", "comic", "bubble", "stencil", "relief", "wobble", "pop", "jitter"];

test("the 12 fonts and 13 effects are in the catalog", () => {
  for (const id of NEW_FONTS) assert.equal(styleById(id)?.category, "font", `font "${id}" missing`);
  for (const id of NEW_EFFECTS) assert.equal(styleById(id)?.category, "effect", `effect "${id}" missing`);
  for (const id of NEW_ENTRANCES) assert.equal(styleById(id)?.category, "entrance", `entrance "${id}" missing`);
});

test("exactly the styles nobody wore are off sale — and still render for their owners", () => {
  const off = USERNAME_STYLES.filter((s) => !forSale(s)).map((s) => s.id).sort();
  assert.deepEqual(off, [...RETIRED].sort());
  // Retired is not removed: an owner still sees their name in it.
  assert.ok(usernameStyleCSS({ font: "western" }, "#ffffff").fontFamily, "a retired font stopped rendering for its owners");
  assert.ok(usernameStyleCSS({ effect: "wobble" }, "#ffffff").animation, "a retired effect stopped rendering for its owners");
});

test("the store lists a retired style only to someone who owns it", () => {
  const src = read("app", "features", "store", "StoreSpend.tsx");
  assert.match(src, /\.filter\(\(s\) => s\.category === cat && \(forSale\(s\) \|\| !!styleState\?\.unlocked\.includes\(s\.id\)\)\)/);
});

test("a retired style cannot be bought", () => {
  const src = read("app", "api", "points", "spend", "style", "route.ts");
  assert.match(src, /if \(!style \|\| !forSale\(style\)/, "the buy route still sells a retired style");
});

test("outline is hollow: no fill, a stroke in the name's colour, no text-shadow filling it back in", () => {
  const c = S(usernameStyleCSS({ effect: "outline" }, "#9fd4ff"));
  assert.equal(c.color, "transparent");
  assert.match(String(c.WebkitTextStroke), /em #/);
  assert.equal(c.textShadow, "none", "a text-shadow draws the WHOLE glyph and fills the hollow back in");
  assert.match(String(c.filter), /drop-shadow/, "the hollow name lost its lift off the background");
});

test("thick outline paints the border UNDER the fill", () => {
  const c = S(usernameStyleCSS({ effect: "thick" }, "#9fd4ff"));
  assert.equal(c.paintOrder, "stroke fill");
  assert.ok(c.WebkitTextStroke);
});

test("colour drift keeps a gradient name's drop-shadows", () => {
  const c = S(usernameStyleCSS({ effect: "drift", gradient: "duo", gradientColor: "#302c68" }, "#b7a2f7"));
  assert.match(String(c.filter), /^hue-rotate\(var\(--un-h, 0deg\)\) var\(--chat-shadow-filter\)$/);
  assert.match(css, /@property --un-h \{[^}]*syntax: "<angle>"/, "--un-h must be a registered angle or it cannot animate");
});

test("type in steps one letter at a time", () => {
  const c = S(usernameStyleCSS({ entrance: "typein" }, "#9fd4ff"));
  assert.match(String(c["--un-enter"]), /steps\(var\(--un-n, 10\)\)/);
  assert.match(read("app", "lib", "nameInk.ts"), /setProperty\("--un-n", String\(/);
});

test("arrival effects play once, and never on history rows", () => {
  for (const id of NEW_ENTRANCES) {
    assert.match(usernameStyleAnimClass({ entrance: id }), /\bun-anim\b/, `"${id}" escaped the motion switches`);
    assert.match(usernameStyleAnimClass({ entrance: id }), /\bun-arrive\b/, `"${id}" is not marked as an arrival`);
    assert.doesNotMatch(String(S(usernameStyleCSS({ entrance: id }, "#fff"))["--un-enter"]), /infinite/, `"${id}" loops`);
  }
  assert.match(css, /\.chat-msg-row:not\(\.chat-msg-in\) \.un-arrive \{ --un-enter: none !important; \}/,
    "every history row would replay its arrival on load");
});

test("every new effect's keyframes exist", () => {
  for (const k of ["un-flicker", "un-glitch", "un-drift", "un-typein", "un-focusin", "un-stamp"]) {
    assert.match(css, new RegExp(`@keyframes ${k} \\{`), `${k} has no keyframes`);
  }
  assert.ok(css.length > 20000, "vacuity: globals.css read to its end");
});

test("the pickers scroll instead of growing", () => {
  assert.match(read("app", "features", "store", "StoreSpend.tsx"), /grid grid-cols-2 gap-1\.5 max-h-64 overflow-y-auto/, "store style tiles");
  assert.match(read("app", "features", "store", "StoreSpend.tsx"), /grid grid-cols-2 gap-2 max-h-56 overflow-y-auto/, "store badges");
  assert.match(read("app", "components", "BadgeSlots.tsx"), /flex flex-wrap gap-1 max-h-32 overflow-y-auto/, "badge catalog in card + Edit profile");
  assert.match(read("app", "components", "ProfileEditor.tsx"), /flex flex-wrap gap-1\.5 max-h-40 overflow-y-auto/, "Edit profile style tiles");
});

test("glitch never lays a text-shadow over a gradient fill", () => {
  const block = css.slice(css.indexOf("@keyframes un-glitch"), css.indexOf("}", css.indexOf("95%", css.indexOf("@keyframes un-glitch"))) + 1);
  assert.doesNotMatch(block, /text-shadow/, "a keyframe text-shadow paints ON TOP of a clipped gradient fill");
  assert.match(block, /filter: var\(--un-f\) drop-shadow/);
  const c = S(usernameStyleCSS({ effect: "glitch", gradient: "duo", gradientColor: "#302c68" }, "#b7a2f7"));
  assert.equal(c.filter, "var(--un-f)");
  assert.match(String((c as Record<string, unknown>)["--un-f"]), /chat-shadow-filter/, "the gradient's own shadows are lost during the glitch");
});

test("thick outline on a gradient name is drawn BEHIND the fill, not over its stems", () => {
  const c = S(usernameStyleCSS({ effect: "thick", gradient: "duo", gradientColor: "#302c68" }, "#b7a2f7"));
  assert.equal(c.WebkitTextStroke, undefined, "a stroke on a clipped fill covers the inner half of every stem");
  assert.match(String(c.filter), /drop-shadow\(0\.06em 0 0 #[0-9a-f]{6}\)/);
});
