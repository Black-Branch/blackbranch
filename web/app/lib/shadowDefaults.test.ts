// Guards for the chat shadow's forms and its device-dependent default.
//
// Two separate invariants live here because they fail the same silent way — the
// markup and the settings panel keep saying exactly what the author intended:
//
//   1. The shadow ships in several forms (text-shadow, drop-shadow filter,
//      box-shadow, the contact layer and the /chat window's halo) derived from
//      ONE spec. The box form exists so the platform indicator's SOLID shapes
//      do not pay for a filter render surface plus two mask blurs on up to 79
//      elements each. Its radii are DOUBLE the other two, which reads like a
//      typo and is not: box-shadow's falloff is about half as wide as
//      drop-shadow's at the same numeric radius (measured on the 3x42 bar; at
//      2x the two match within rms 1.20, max 6 of 255).
//
//   2. `shadowOn` defaults OFF on mobile. That default is a SECOND truth
//      about what an absent key means, and it lives in two places that cannot
//      import each other: the registry, and the hand-written pre-paint script
//      in layout.tsx. check-prepaint proves the key is READ there. Only this
//      file proves the two agree on what absent MEANS — and if they disagree, a
//      phone paints the shadow for a frame and drops it, or shows a toggle that
//      says "on" over a chat with no shadow.
//
// Run: node --test app/lib/shadowDefaults.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments, stripCssComments } from "./testSource.ts";

const read = (...p: string[]) => stripComments(readFileSync(join(process.cwd(), ...p), "utf8"));
// globals.css needs stripCssComments. stripComments ends with a pass that
// deletes every line starting with `--` (SQL comments inside template
// literals), which in a stylesheet is every custom-property declaration —
// `--chat-shadow-box:` and friends silently vanish, and an assertion on a
// declaration would fail invisibly.
const readCss = () => stripCssComments(readFileSync(join(process.cwd(), "app", "globals.css"), "utf8"));

// The pre-paint script only — comments elsewhere in layout.tsx must not satisfy
// these, same reasoning as check-prepaint.mjs.
function prePaint(): string {
  const src = read("app", "layout.tsx");
  const start = src.indexOf("__html:");
  const end = src.indexOf("`}}", start);
  assert.ok(start !== -1 && end !== -1, "setup: could not find the pre-paint script body");
  return src.slice(start, end);
}

test("the box form's radii are DOUBLE the other two, from one named constant", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /const SHADOW_BOX_SCALE = 2;/,
    "SHADOW_BOX_SCALE is gone or changed — if SHADOW_BASE moved, the sweep that " +
    "produced this factor has to be re-run, not adjusted by eye");
  assert.match(reg, /const b1 = \(SHADOW_BASE\.r1 \* blur \* SHADOW_BOX_SCALE\)/,
    "the box form no longer derives from SHADOW_BASE x SHADOW_BOX_SCALE");
  assert.match(reg, /const b2 = \(SHADOW_BASE\.r2 \* blur \* SHADOW_BOX_SCALE\)/);
  // Same alphas as the other two forms — only the radii differ.
  const spec = reg.match(/function shadowSpec\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(spec.length > 0, "setup: could not find shadowSpec()");
  assert.match(spec, /box:\s+`\$\{o1\} \$\{b1\}px rgba\(0,0,0,\$\{a1\}\), \$\{o2\} \$\{b2\}px rgba\(0,0,0,\$\{a2\}\)`/,
    "the box form's alphas drifted from the text/filter forms — all three are ONE shadow");
});

test("every form is written on, and cleared, together", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  const fn = reg.match(/function applyShadow\(ctx: ApplyCtx\) \{[\s\S]*?rmProp\("--panel-shadow"\); \}/)?.[0] ?? "";
  assert.ok(fn.length > 0, "setup: could not find applyShadow()");
  for (const v of ["--chat-shadow", "--chat-shadow-filter", "--chat-shadow-box", "--chat-shadow-contact", "--chat-shadow-halo"]) {
    const writes = (fn.match(new RegExp(`setProp\\("${v}"`, "g")) ?? []).length;
    assert.equal(writes, 2, `${v} is not written in BOTH the off and on branches of applyShadow — ` +
      "a form that is set in only one of them keeps a stale value when the toggle flips");
  }
  // The off values differ ON PURPOSE and the difference is load-bearing.
  assert.match(fn, /setProp\("--chat-shadow-filter", EMPTY_FILTER\)/,
    "the filter's off value is back to a keyword — `saturate(X) none` is invalid CSS " +
    "and drops the indicator's saturation with it (W4/S-09)");
  assert.match(fn, /setProp\("--chat-shadow-box", "none"\)/);
});

test("only SOLID shapes use the box form; variable-alpha artwork keeps the filter", () => {
  const css = readCss();
  // The bar is a solid rect and the dot a solid circle — box-shadow draws their
  // shadow exactly, with no render surface.
  assert.match(css, /\.chat-msg-row \.chat-pi-bar-el,\n\.chat-msg-body \.chat-pi-dot-el \{\n  box-shadow: var\(--chat-shadow-box\);\n  filter: saturate\(var\(--chat-pi-sat, 1\)\);\n\}/,
    "the indicator's solid shapes no longer use the box form — that is 79 filter " +
    "render surfaces and 158 mask blurs coming back on a full chat buffer");
  // The icon wraps an SVG glyph: its alpha mask IS what the shadow is of.
  assert.match(css, /\.chat-msg-body \.chat-pi-icon-el \{\n  filter: saturate\(var\(--chat-pi-sat, 1\)\) var\(--chat-shadow-filter\);\n\}/,
    "the icon lost the filter form — box-shadow would shadow its bounding box, not its artwork");
  for (const sel of ["chat-badges", "chat-pfp"]) {
    assert.doesNotMatch(css, new RegExp(`\\.${sel}[^{]*\\{[^}]*--chat-shadow-box`),
      `${sel} is an image with real alpha — box-shadow would shadow its box, not its artwork`);
  }
});

test("mobile defaults the shadow OFF, in the registry and the pre-paint alike", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  // Pinned to the EXACT map on purpose: every entry needs a hand-written mirror
  // in the pre-paint script, and nothing else proves someone wrote it. Growing
  // the map is meant to fail here, then be re-pinned deliberately. (glassOn is
  // mirrored in the two pre-paint blocks and pinned by glassSurface.test.ts;
  // transparencyOn is ON on phones, so it is not in the map.)
  assert.match(reg, /const MOBILE_DEFAULTS: Partial<Values> = \{ shadowOn: false, glassOn: false \};/,
    "the mobile-defaults map changed — every entry here needs a hand-written " +
    "mirror in the pre-paint script, so re-pin this only after adding one");
  assert.match(reg, /return \(v === null \? defaultFor\(key\) : v\)/,
    "parseValue fell back to DEFAULTS again, so the device-dependent default is dead " +
    "everywhere at once — this is the ONE choke point");

  const pp = prePaint();
  assert.match(pp, /_sh === '0' \|\| \(_sh === null && _shMob\)/,
    "the pre-paint no longer applies the mobile default — a phone would paint the " +
    "shadow until hydration, then drop it");
  assert.match(pp, /matchMedia\('\(pointer: coarse\) and \(max-width: 1024px\)'\)/,
    "the pre-paint's device test drifted from deviceClass()");
});

test("the pre-paint device test is character-for-character deviceClass()", () => {
  // Two different queries would disagree on exactly the devices in between —
  // a tablet, a touch laptop — which is the hardest kind of bug to reproduce.
  const dc = read("app", "lib", "deviceQueries.ts");
  const q = dc.match(/export const Q_DEVICE_MOBILE = "([^"]+)"/)?.[1];
  assert.ok(q, "setup: could not read Q_DEVICE_MOBILE out of deviceQueries.ts");
  assert.ok(prePaint().includes(`matchMedia('${q}')`),
    `the pre-paint must use deviceClass()'s exact query (${q})`);
});

test("the pre-paint emits every form in all three of its branches (off, hard, soft)", () => {
  const pp = prePaint();
  for (const v of ["--chat-shadow", "--chat-shadow-filter", "--chat-shadow-box", "--chat-shadow-contact", "--chat-shadow-halo"]) {
    const n = (pp.match(new RegExp(`setProperty\\('${v}'`, "g")) ?? []).length;
    assert.equal(n, 3, `${v} is not emitted in all three pre-paint branches — the form it misses ` +
      "falls back to the :root default and flashes on reload");
  }
  // The doubled radii, restated here because the script cannot import anything.
  assert.match(pp, /var _b1 = \(8 \* _sb\)\.toFixed\(2\), _b2 = \(24 \* _sb\)\.toFixed\(2\);/,
    "the pre-paint's box radii drifted from SHADOW_BASE x SHADOW_BOX_SCALE (4x2, 12x2)");
});

// The HALO forms: the see-through /chat window's extra glow is two more forms
// of the SAME setting — radius follows blur, alpha follows strength, and off
// clears them with the rest. A fixed pair of literals in globals.css would
// ignore the sliders and, on images, stay on with the Shadow toggle off.
test("the halo derives from the same two sliders, and its default matches :root", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /const HALO_BASE = \{ r: 14, a: 0\.8 \};/);
  const spec = reg.match(/function shadowSpec\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(spec.length > 0, "setup: could not find shadowSpec()");
  assert.match(spec, /halo:\s+`0 0 \$\{h\}px rgba\(0,0,0,\$\{ha\}\)`/);
  assert.match(spec, /const h = \(HALO_BASE\.r \* blur\)/);
  assert.match(spec, /const ha = Math\.min\(1, HALO_BASE\.a \* strength\)/);
  const fn = reg.match(/function applyShadow\(ctx: ApplyCtx\) \{[\s\S]*?rmProp\("--panel-shadow"\); \}/)?.[0] ?? "";
  assert.match(fn, /setProp\("--chat-shadow-halo", "none"\)/);
  // Sliders at 1/1 write nothing in the pre-paint, so :root IS the default look.
  const css = readCss();
  assert.match(css, /--chat-shadow-halo:\s+0 0 14px rgba\(0,0,0,0\.8\);/);
  const pp = prePaint();
  assert.match(pp, /var _h = \(14 \* _sb\)\.toFixed\(2\);/);
  assert.match(pp, /var _ha = Math\.min\(1, 0\.8 \* _ss\)\.toFixed\(3\);/);
});

// PICTURES GET ONE TIGHT LAYER. The filter form re-runs on every frame of
// every animated picture; the chain + the window's picture halo was ~70% of
// the Shadow setting's GPU cost (Firefox, /chat window: off 15%, chain 29%,
// tight 21%). Pinned in all three places that state it, and the retired
// picture-halo var must not come back in any of them.
test("the picture (filter) form is the tight layer alone, everywhere it is stated", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  const spec = reg.match(/function shadowSpec\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(spec, /filter: `drop-shadow\(\$\{o1\} \$\{r1\}px rgba\(0,0,0,\$\{a1\}\)\)`,/,
    "the soft picture shadow is a chain again");
  const css = readCss();
  assert.match(css, /--chat-shadow-filter: drop-shadow\(0 1px 4px rgba\(0,0,0,1\)\);/,
    "the :root default is a chain again — every reader with default sliders pays for it");
  const pp = prePaint();
  assert.match(pp, /setProperty\('--chat-shadow-filter', 'drop-shadow\(' \+ _o1 \+ ' ' \+ _r1 \+ 'px rgba\(0,0,0,' \+ _a1 \+ '\)\)'\);/,
    "the pre-paint's picture shadow is a chain again");
  for (const [name, src] of [["settingsRegistry.ts", reg], ["globals.css", css], ["layout.tsx", pp]] as const) {
    assert.doesNotMatch(src, /--chat-shadow-halo-filter|haloFilter/, `${name} brought the picture halo back`);
  }
});

// HARD style (an OBS trick: duplicate the chat in black, shift it a couple of
// pixels diagonally). No blur at all, so no blur pass.
test("hard shadow: every form is one solid, unblurred copy offset down-right", () => {
  const reg = read("app", "lib", "settingsRegistry.ts");
  assert.match(reg, /const HARD_OFFSET_PX = 2;/);
  const spec = reg.match(/function shadowSpec\([\s\S]*?\n\}/)?.[0] ?? "";
  const hard = spec.slice(spec.indexOf("if (hard) {"), spec.indexOf("const r1 ="));
  assert.ok(hard.length > 0, "setup: shadowSpec has no hard branch");
  // The offset is (o, o) turned/scaled by the direction/distance sliders — shadowSpec.test.ts runs it.
  assert.match(hard, /const solid = `\$\{shadowOffset\(o, o, angle, distance\)\} 0 rgba\(0,0,0,\$\{a1\}\)`;/, "the hard copy grew a blur or lost its offset");
  for (const form of ["text: solid", "contact: solid", "filter: `drop-shadow(${solid})`", "box: solid"]) {
    assert.ok(hard.includes(form), `hard branch: ${form} missing`);
  }
  // The window composes the halo into a text-shadow LIST, where `none` is invalid.
  assert.match(hard, /halo: "0 0 0 transparent"/);
  const fn = reg.match(/function applyShadow\(ctx: ApplyCtx\) \{[\s\S]*?rmProp\("--panel-shadow"\); \}/)?.[0] ?? "";
  assert.match(fn, /shadowSpec\(ctx\.get\("shadowStrength"\), ctx\.get\("shadowBlur"\),\s+ctx\.get\("shadowAngle"\), ctx\.get\("shadowDistance"\), ctx\.get\("shadowHard"\)\)/,
    "applyShadow no longer passes the hard switch through");
  // The pre-paint mirrors it, or a hard-shadow reader sees the soft one for a frame on every load.
  const pp = prePaint();
  const ppHard = pp.slice(pp.indexOf("localStorage.getItem('chatStyle_shadowHard') === '1'"), pp.indexOf("} else {", pp.indexOf("chatStyle_shadowHard")));
  assert.ok(ppHard.length > 0, "the pre-paint has no hard branch");
  assert.match(ppHard, /var _hsolid = _off\(2, 2\) \+ ' 0 rgba\(0,0,0,'/, "the pre-paint's hard offset drifted from HARD_OFFSET_PX");
  assert.match(ppHard, /setProperty\('--chat-shadow-halo', '0 0 0 transparent'\)/);
  // Blur means nothing to a hard shadow, so the menu hides its slider.
  const menu = read("app", "lib", "settingsMenu.ts");
  assert.match(menu, /s\("shadowBlur", \(v\) => v\.shadowOn && !v\.shadowHard\)/);
  assert.match(menu, /s\("shadowHard", \(v\) => v\.shadowOn\)/);
});
