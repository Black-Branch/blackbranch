// The panel float shadow — one definition, never on a phone.
//
// An INLINE style beats every cascade layer and every media query, so a panel
// shadow applied inline is one no setting and no breakpoint can reach: the
// Shadow toggle reads "off" while the largest shadow on the page keeps
// painting. Measured on a phone, that one shadow was nearly all of the
// box-shadow cost left on screen. So:
//   • the value lives in `--panel-shadow` in globals.css, consumed by
//     `.bb-panel`, with two layers (a third cost most of the field and was
//     barely visible);
//   • the Shadow toggle governs it on desktop, through applyShadow;
//   • phones never get it AT ALL, via a plain media query, so it is not a
//     default a user can turn back on and there is no first-paint window where
//     it exists.
//
// Run: node --test app/lib/panelShadow.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
// CSS gets its OWN stripper. stripComments ends with a pass that deletes any
// line starting with `--` (SQL comments inside template literals), which in a
// stylesheet is the shape of every custom-property declaration — `--panel-shadow`
// would silently vanish and this file would report it missing. testSource.ts
// says so too.
const CSS = stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));
const CSSN = CSS.replace(/\s+/g, " ");   // whitespace-insensitive, for rule shapes
const REG = read("app", "lib", "settingsRegistry.ts");
const LAYOUT = read("app", "layout.tsx");
const VIEW = read("app", "components", "StreamView.tsx");
const DEVICE = read("app", "lib", "deviceQueries.ts");

test("neither panel carries an inline boxShadow any more", () => {
  // This is the whole bug. An inline style beats layers AND media queries, so
  // while it was here the setting could not turn the shadow off and the phone
  // rule below could not zero it. A `boxShadow:` anywhere in StreamView means
  // both of those silently stop working — with no visual change on desktop,
  // which is where it would be reviewed.
  assert.doesNotMatch(VIEW, /boxShadow:/,
    "StreamView sets an inline boxShadow again — it will beat both the Shadow " +
    "toggle and the mobile media query, exactly as FRAME_SHADOW did");
  assert.doesNotMatch(VIEW, /FRAME_SHADOW/,
    "the FRAME_SHADOW constant is back; the value belongs in globals.css");
});

test("the panel shadow is defined once, in globals.css, and is a PAIR", () => {
  const root = CSSN.match(/:root \{ --panel-shadow:([^;]*);/);
  assert.ok(root, "--panel-shadow lost its :root definition");
  const layers = root[1]!.split(/,(?![^(]*\))/).length;
  assert.equal(layers, 2,
    `--panel-shadow has ${layers} layers, expected 2 — a third layer was measured ` +
    "at 58% of the field for max 3/255 of visible difference (deleted), and " +
    "collapsing to one costs a guessed alpha for another 11%");
  assert.match(CSSN, /\.bb-panel \{ box-shadow: var\(--panel-shadow\); \}/,
    "the .bb-panel consumer rule is gone, so the property is dead");
});

test("phones are zeroed unconditionally, not merely defaulted off", () => {
  // The phone rule is stronger than the shadowOn mobile default: a phone user
  // who turns Shadow ON gets chat-row shadows and still no panel float. That is
  // only true if the media query sets box-shadow DIRECTLY — routing it through
  // --panel-shadow would let applyShadow's ON branch overwrite it.
  const mq = CSSN.match(
    /@media \(pointer: coarse\) and \(max-width: 1024px\) \{ \.bb-panel \{ box-shadow: none; \} \}/
  );
  assert.ok(mq, "the mobile .bb-panel { box-shadow: none } rule is gone or now " +
    "goes through a custom property, which applyShadow could overwrite");
  // It must come AFTER the base rule: equal specificity, so source order decides.
  assert.ok(CSSN.indexOf(mq[0]) > CSSN.indexOf(".bb-panel { box-shadow: var(--panel-shadow); }"),
    "the mobile rule now precedes the base rule — equal specificity means the " +
    "base rule wins and phones paint the shadow again");
});

test("that media query is deviceClass()'s, character for character", () => {
  // Same invariant shadowDefaults.test.ts pins for the pre-paint script: if the
  // two drift, "mobile" means different things in CSS and in TS and the app is
  // internally inconsistent about which device it is on.
  const dq = DEVICE.match(/export const Q_DEVICE_MOBILE = "([^"]+)"/);
  assert.ok(dq, "Q_DEVICE_MOBILE is no longer a plain string literal in deviceQueries.ts");
  assert.ok(CSS.includes(`@media ${dq[1]!} {`),
    `globals.css does not contain "@media ${dq[1]}" — the CSS and TS definitions ` +
    "of mobile have drifted apart");
});

test("applyShadow turns it off with the keyword and turns it on by REMOVING", () => {
  const fn = REG.slice(REG.indexOf("function applyShadow"), REG.indexOf("function applySeam"));
  assert.match(fn, /setProp\("--panel-shadow", "none"\)/,
    "the off branch no longer zeroes the panel shadow");
  assert.match(fn, /rmProp\("--panel-shadow"\)/,
    "the on branch must REMOVE the override so globals.css's :root pair applies — " +
    "restating the value here would be a second place to change it");
  assert.doesNotMatch(fn, /setProp\("--panel-shadow", (?!"none")/,
    "the on branch is writing a value again; the pair lives in globals.css");
});

test("the pre-paint mirror emits the same off-value and nothing else", () => {
  // check-prepaint proves the shadow KEY is read here; it cannot prove the two
  // sides agree. ON must stay absent from this script: emitting a value would
  // pin the pair in a third place, and 'none'-on-mobile is already the CSS's job.
  assert.match(LAYOUT, /setProperty\('--panel-shadow', 'none'\)/,
    "the pre-paint script stopped mirroring the panel shadow's off state — a " +
    "desktop user with Shadow off gets one frame of panel shadow on every load");
  const hits = LAYOUT.match(/setProperty\('--panel-shadow',[^)]*\)/g) ?? [];
  assert.equal(hits.length, 1,
    `${hits.length} --panel-shadow writes in the pre-paint script; there should be ` +
    "exactly one, the 'none' in the shadow-off branch");
});

test("the panel shadow does NOT scale with the chat row's strength/blur", () => {
  // shadowStrength/shadowBlur are labelled "Shadow strength"/"Shadow blur" under
  // Message row and were derived for glyph-sized shadows (SHADOW_BASE). Feeding
  // a 366x593 panel through them would make a 2x blur a 112px blur on the
  // biggest surface in the app — the exact cost P3 exists to remove.
  const spec = REG.slice(REG.indexOf("function shadowSpec"), REG.indexOf("const SEAM_BASE"));
  // `contact` is the tight layer alone, for the glow, and `halo` is the /chat
  // window's glyph-sized halo, kept here so the Shadow controls reach it. Both
  // are CHAT-ROW forms, which is what this guard permits; what it forbids is a
  // PANEL form, and the assertion below is an exact list precisely so adding
  // one cannot pass unnoticed. The hard branch returns the same five forms,
  // indented deeper, so this soft-branch list is the whole set.
  const forms = [...spec.matchAll(/^\s{4}(\w+):\s/gm)].map((m) => m[1]);
  assert.deepEqual(forms, ["text", "contact", "filter", "box", "halo"],
    `shadowSpec returns [${forms}] — it must stay the chat row's forms. A ` +
    "panel form here would run a 366x593 surface through sliders derived for glyphs");
});
