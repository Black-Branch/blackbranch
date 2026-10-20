import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  USERNAME_STYLES, styleById, usernameStyleCSS, usernameStyleAnimClass,
  type EquippedStyle,
} from "./usernameStyles.ts";
import { readableColor, cssColorLuma } from "./colors.ts";
import { FONT_METRICS, REFERENCE_METRICS, scaleFor, wordSpacingFor } from "./usernameFontMetrics.ts";
import { stripComments, stripCssComments, servedFontVariables } from "./testSource.ts";

// The catalog is code-only — there is no DB CHECK on style_id and no enum, so
// nothing outside this file stops a malformed entry from reaching the store.
// These tests are the whole safety net for adding a style.

const HERE = new URL(".", import.meta.url).pathname;
const src = (p: string) => stripComments(readFileSync(join(HERE, p), "utf8"));

// CSS goes through stripCssComments, NOT stripComments — see the note there.
const cssSrc = (p: string) => stripCssComments(readFileSync(join(HERE, p), "utf8"));

const ids = (cat: string) =>
  USERNAME_STYLES.filter((s) => s.category === cat).map((s) => s.id);

test("style ids are unique across the whole catalog", () => {
  const seen = new Set<string>();
  for (const s of USERNAME_STYLES) {
    assert.equal(seen.has(s.id), false, `duplicate style id: ${s.id}`);
    seen.add(s.id);
    assert.equal(styleById(s.id)?.category, s.category);
  }
});

// ── The fence invariant ──────────────────────────────────────────────────────
// This is the one that matters. An animation that renders without `un-anim` is
// unreachable by prefers-reduced-motion, by the "Animate name styles" toggle,
// AND by the off-screen fence — infinite unstoppable paint on every chat row.
// Enumerating the catalog (rather than listing the animated ids) means a style
// added next year is covered by this test the moment it is added.

const EVERY_SET: EquippedStyle[] = [];
for (const font of [null, ...ids("font")]) {
  for (const effect of [null, ...ids("effect")]) {
    for (const gradient of [null, ...ids("gradient")]) {
      EVERY_SET.push({ font, effect, gradient });
    }
  }
}

test("un-anim is applied to exactly the sets that render an animation", () => {
  assert.ok(EVERY_SET.length > 100, "catalog sweep should be non-trivial");
  for (const eq of EVERY_SET) {
    const css = usernameStyleCSS(eq, "#7dd9a8");
    const animates = typeof css.animation === "string" && css.animation.length > 0;
    const tagged = /\bun-anim\b/.test(usernameStyleAnimClass(eq));
    assert.equal(
      tagged, animates,
      `un-anim/animation mismatch for ${JSON.stringify(eq)} — ` +
      `animation=${JSON.stringify(css.animation)} class=${JSON.stringify(usernameStyleAnimClass(eq))}`
    );
  }
});

test("shimmer under rainbow drops its own animation but stays fenced", () => {
  // The one asymmetric case: shimmer's branch is skipped so the two do not
  // fight over background-position. It is only safe because rainbow animates.
  const eq = { effect: "shimmer", gradient: "rainbow" };
  const css = usernameStyleCSS(eq, "#e697ce");
  assert.match(String(css.animation), /un-rainbow/);
  assert.doesNotMatch(String(css.animation), /un-shimmer/);
  assert.equal(usernameStyleAnimClass(eq), "un-anim");
});

test("every animation name emitted has keyframes in globals.css", () => {
  const css = cssSrc("../globals.css");
  const names = new Set<string>();
  for (const eq of EVERY_SET) {
    const anim = usernameStyleCSS(eq, "#8ab4ff").animation;
    if (typeof anim !== "string") continue;
    // Take the leading identifier of each entry rather than splitting on ",":
    // an animation VALUE may legitimately contain commas (`steps(3, end)`), so
    // a naive split invents entries that were never there.
    for (const m of anim.matchAll(/(?:^|,)\s*(un-[a-z]+)\b/g)) names.add(m[1]!);
  }
  assert.ok(names.size >= 7, `expected the animated set, got ${[...names].join(",")}`);
  for (const n of names) {
    assert.match(css, new RegExp(`@keyframes\\s+${n}\\b`), `no @keyframes for ${n}`);
  }
});

test("the un-anim hooks in globals.css still cover all three off-switches", () => {
  const css = cssSrc("../globals.css");
  // reduced-motion kill, the settings toggle, and the off-screen fence.
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.un-anim\s*\{\s*animation:\s*none/);
  assert.match(css, /\.un-noanim\s+\.un-anim\s*\{\s*animation:\s*none/);
  assert.match(css, /\[data-anim-off\][\s\S]{0,400}?\.un-anim\s*\{[^}]*animation-play-state:\s*paused/);
});

// ── Fonts ────────────────────────────────────────────────────────────────────

test("every font style has a stack, and every stack var is served by the site", () => {
  const styles = src("./usernameStyles.ts");
  const served = servedFontVariables();
  assert.ok(served.size >= 80, `the site serves ${served.size} font variables`);
  for (const id of ids("font")) {
    const css = usernameStyleCSS({ font: id }, "#ffffff");
    const family = String(css.fontFamily ?? "");
    assert.ok(family, `font style "${id}" has no FONT_STACKS entry`);
    const varName = /var\((--font-[\w-]+)\)/.exec(family)?.[1];
    assert.ok(varName, `font style "${id}" does not reference a CSS variable: ${family}`);
    // Declared (vendored stylesheet, or next/font/local) AND on <html> — either half alone
    // silently falls back to the generic family. servedFontVariables() checks both.
    assert.ok(served.has(varName), `${varName} (style "${id}") is not served (fonts/google/fonts.css or layout.tsx)`);
    // A generic fallback keeps the name legible while the face is still loading.
    assert.match(family, /,\s*(serif|sans-serif|monospace|cursive|fantasy)\s*$/, `"${id}" stack: ${family}`);
    assert.ok(styles.includes(`${id}:`), `"${id}" missing from FONT_STACKS`);
  }
});

test("a scaled font keeps the row's line box instead of growing it", () => {
  // The scales span 0.73 to 1.52, so without the division an Elegant name would
  // claim a line box more than twice an Arcade one and its chat row would
  // visibly jump. Every scaled face must divide; an unscaled one must not set
  // line-height at all, so it plainly inherits.
  //
  // The division fixes the ROW, not the ink. A tall face is allowed to overlap
  // its neighbours — that is the division working, not failing.
  for (const id of ids("font")) {
    const css = usernameStyleCSS({ font: id }, "#ffffff");
    const n = Number(String(css.fontSize ?? "1em").replace("em", ""));
    assert.ok(Number.isFinite(n), `"${id}" fontSize is not an em number: ${css.fontSize}`);
    // Outside this band means a mis-measurement, not a design choice. 1.6:
    // x-parity puts Elegant and Handwritten at 1.52, and the band is a guess
    // about what a bad measurement looks like, not a limit anything actually
    // enforces.
    assert.ok(n >= 0.6 && n <= 1.6, `"${id}" scale ${n} is out of band`);
    assert.equal(
      css.lineHeight, `calc(var(--chat-line-height, 1.4) / ${n})`,
      `"${id}" scales to ${n}em without dividing its line-height`
    );
  }
  assert.equal(usernameStyleCSS({ effect: "glow" }, "#ffffff").lineHeight, undefined);
});

test("every scale is DERIVED from a measurement, not typed in", () => {
  // A table retuned by eye leaves faces nobody re-measured. Recomputing each
  // scale from the stored metrics means a hand-edit fails here, and
  // re-measuring is the only way to move a number.
  for (const id of ids("font")) {
    const m = FONT_METRICS[id];
    assert.ok(m, `"${id}" has no measured metrics — it was added without measuring (see usernameFontMetrics.ts)`);
    const css = usernameStyleCSS({ font: id }, "#ffffff");
    const shipped = Number(String(css.fontSize ?? "1em").replace("em", ""));
    assert.equal(
      shipped, scaleFor(m),
      `"${id}" ships scale ${shipped} but its measurements derive ${scaleFor(m)} — ` +
      `either the scale was typed in, or the metrics are stale`
    );
  }
});

test("the measured faces are all DISTINCT fonts, not the fallback over and over", () => {
  // The failure this catches actually happened: handing the full stack to
  // document.fonts.load() measured the metric-override fallback for 15 of 19
  // faces, all reporting identical metrics, and the derived scales looked
  // perfectly plausible. Identical numbers across unrelated faces is the tell.
  const words = Object.values(FONT_METRICS).map((m) => m.word);
  assert.equal(
    new Set(words).size, words.length,
    "two faces measured to the same advance width — at least one fell back to " +
    "the default font and its scale is meaningless"
  );
  for (const [id, m] of Object.entries(FONT_METRICS)) {
    assert.notEqual(
      m.word, REFERENCE_METRICS.word,
      `"${id}" measured identically to the reference face — it did not load`
    );
  }
});

// ── sized to FEEL like a plain name ─────────────────────────────────────────
// Every face beside a plain name at chat size should feel comparable to it —
// an x-height-anchored rule leaves Comic/Horror/Blackletter reading small and
// Handwritten/Elegant towering. These pin the BEHAVIOUR of the rule on
// synthetic faces, so a retune that breaks one of the criteria fails by name,
// whatever the table says.
const face = (o: Partial<typeof REFERENCE_METRICS>) => ({ ...REFERENCE_METRICS, ...o });

test("a capitals-only face is matched to plain CAPITALS, never squashed below them", () => {
  for (const id of ["comic", "horror", "street"]) {
    const m = FONT_METRICS[id]!;
    assert.ok(m.x / m.capH > 0.9, `"${id}" is expected to draw every glyph at one height`);
    const caps = (m.capH * scaleFor(m)) / REFERENCE_METRICS.capH;
    assert.ok(caps >= 0.99 && caps < 1.15, `"${id}" capitals render at ${caps.toFixed(2)}× a plain name's`);
  }
});

test("no face's lowercase reads smaller than 0.92 of a plain name", () => {
  for (const [id, m] of Object.entries(FONT_METRICS)) {
    const parity = (m.x * scaleFor(m)) / REFERENCE_METRICS.x;
    assert.ok(parity >= 0.915, `"${id}" lowercase renders at ${parity.toFixed(2)}× a plain name`);
    // A capitals-only face's "x" IS its capitals — held by the caps test above.
    if (m.x / m.capH <= 0.9) assert.ok(parity < 1.3, `"${id}" lowercase renders at ${parity.toFixed(2)}× a plain name`);
  }
});

test("a narrow face is lifted, and a wide face is never shrunk for its width", () => {
  const base = face({ capH: 0.72, x: 0.55 });
  const narrow = scaleFor({ ...base, word: base.word * 0.7 });
  assert.ok(narrow > scaleFor(base), "a condensed face reads small and must be lifted");
  assert.equal(scaleFor({ ...base, word: base.word * 1.8 }), scaleFor(base),
    "a wide face must not be shrunk — width only ever lifts");
});

test("a hollow outline face still gets its make-up", () => {
  const m = FONT_METRICS.relief!;
  assert.ok(scaleFor(m) > scaleFor({ ...m, iRuns: 1, dotRuns: 1 }), "relief lost the hollow make-up");
});

test("towering capitals are pulled in: no face's capitals pass 1.45× a plain name's", () => {
  for (const [id, m] of Object.entries(FONT_METRICS)) {
    const caps = (m.capH * scaleFor(m)) / REFERENCE_METRICS.capH;
    assert.ok(caps < 1.45, `"${id}" capitals render at ${caps.toFixed(2)}× a plain name's`);
  }
});

test("a space in any face is as wide as a plain name's space ('Mx. Cho')", () => {
  for (const [id, m] of Object.entries(FONT_METRICS)) {
    const s = scaleFor(m);
    const ws = wordSpacingFor(m);
    const rendered = m.space * s + ws * s; // row em
    assert.ok(Math.abs(rendered - REFERENCE_METRICS.space) < 0.01,
      `"${id}" renders a space ${rendered.toFixed(3)}em wide, a plain one is ${REFERENCE_METRICS.space}em`);
    const css = usernameStyleCSS({ font: id }, "#ffffff") as Record<string, unknown>;
    if (Math.abs(ws) >= 0.01) assert.equal(css.wordSpacing, `${ws}em`, `"${id}" does not ship its word spacing`);
    else assert.equal(css.wordSpacing, undefined, `"${id}" ships a word spacing too small to matter`);
  }
});

// ── the shadow must not eat the glow ────────────────────────────────────────
// A change in the shadows must not wash out the name glow.
//
// This is a REAL coupling, not a taste call: with the full shadow on glow, the
// only lever a viewer has is the GLOBAL shadow — lowering it to under half the
// default to rescue one purchased effect costs every other name in chat its
// lift.
//
// The full two-layer chat shadow on glow is the problem: the wide layer is
// 12px × the blur slider (up to 36px) in near-opaque black, while the glow's
// own halo is a fixed 14px — so past ~1× the black is wider than the thing it
// sits under and swallows it. The contact layer does the lifting; the wide one
// only competes.
test("glow appends the CONTACT shadow, never the full one", () => {
  // Asserts the OUTPUT, not the source. Grepping the glow branch for the
  // constant's NAME stops meaning anything once the branch collects layers
  // instead of writing the string itself.
  const shadow = String(usernameStyleCSS({ effect: "glow" }, "#8ab4ff").textShadow);
  assert.match(shadow, /var\(--chat-shadow-contact\)/,
    "glow lost the contact layer, so it sits flat while every plain name is lifted");
  // Terminator-anchored: `var(--chat-shadow-contact)` CONTAINS the string
  // `--chat-shadow`, so a bare check here proves nothing.
  assert.doesNotMatch(shadow, /var\(--chat-shadow\)/,
    "glow is back on the full chat shadow — its wide layer will swallow the halo (T19)");
});

test("no glow layer is opaque, and the OUTER bloom is lighter", () => {
  // Two different reports, and the fix for the first caused the second:
  //
  //  • The glow "washes out the username". Cause: the halo was the
  //    glyph's own colour at FULL opacity, 6px out — no contrast between a
  //    letter and its own bloom, counters filled in, letterforms dissolved.
  //  • k, after the first fix: it "changed the entire username color". Cause:
  //    lightening the NEAR layer. A light corona hugging the strokes shifts the
  //    whole impression — and on a gradient name the halo paints OVER the fill,
  //    so it recolours the glyph outright.
  //
  // So the property is about OPACITY and DISTANCE, not colour: the near layer
  // keeps the glyph's hue and merely stops being opaque, and only the outer
  // bloom lightens, which is where light actually disperses.
  const lum = (h: string) => cssColorLuma(h) ?? 0;
  for (const c of ["#7dd9a8", "#8ab4ff", "#ff5e5e", "#333333"]) {
    // The glyph renders in readableColor(c), not the raw pick.
    const fill = readableColor(c);
    const shadow = String(usernameStyleCSS({ effect: "glow" }, c).textShadow);
    // Every coloured layer must carry an alpha suffix — an opaque one is what
    // filled the counters, whatever colour it is.
    const layers = shadow.split(/,(?![^(]*\))/).filter((l) => /#[0-9a-f]{6}/i.test(l));
    assert.ok(layers.length >= 2, `glow lost its halo layers: ${shadow}`);
    for (const l of layers) {
      assert.match(
        l, /#[0-9a-f]{8}\b/i,
        `a glow layer is fully opaque — that is what filled the counters: ${l.trim()}`
      );
    }
    // The near layer keeps the glyph's own hue; the far one lightens.
    const near = layers[0]!.match(/#([0-9a-f]{6})/i)![1]!;
    const far = layers[layers.length - 1]!.match(/#([0-9a-f]{6})/i)![1]!;
    assert.equal(
      ("#" + near).toLowerCase(), fill.toLowerCase(),
      `the near halo is not the glyph's colour for ${c} — it will read as a colour change`
    );
    assert.ok(
      lum("#" + far) > lum(fill),
      `the outer bloom ${far} is not lighter than the glyph ${fill} — a darker halo is a shadow`
    );
  }
});

test("a GRADIENT name shadows with drop-shadow, never text-shadow", () => {
  // `background-clip: text` puts the glyph colour in the BACKGROUND and leaves
  // the text transparent, which inverts the paint order: a text-shadow lands ON
  // TOP of the fill instead of behind it — black smeared across the user
  // card's name, or glow recolouring a name outright.
  //
  // `textShadow: "none"` is load-bearing, not tidiness: without it the chat
  // row's INHERITED --chat-shadow still paints over the fill.
  for (const eq of [
    { gradient: "duo", gradientColor: "#302c68" },
    { gradient: "duo", effect: "glow" },
    { gradient: "rainbow" },
    { effect: "shimmer" },
  ]) {
    const css = usernameStyleCSS(eq, "#c472e4");
    assert.equal(css.color, "transparent", `setup: ${JSON.stringify(eq)} should clip its fill`);
    assert.equal(
      css.textShadow, "none",
      `${JSON.stringify(eq)} leaves text-shadow live — the row's shadow will paint over the fill`
    );
    // Either literal drop-shadow() layers (an effect contributed some) or
    // --chat-shadow-filter, which IS the two chat shadows in drop-shadow form.
    assert.match(
      String(css.filter), /drop-shadow\(|--chat-shadow-filter/,
      `${JSON.stringify(eq)} has no drop-shadow, so a gradient name sits flat on the theme`
    );
  }
});

test("a PLAIN name sets no shadow at all and inherits the row's", () => {
  // Setting an equivalent value here would silently detach the name from the
  // reader's own shadow settings — it would stop following the blur slider.
  const css = usernameStyleCSS({ font: "gothic" }, "#8ab4ff");
  assert.equal(css.textShadow, undefined, "a plain name now overrides the row's shadow");
  assert.equal(css.filter, undefined);
});

test("emboss KEEPS the full shadow — it has no halo to swallow", () => {
  // The opposite of glow: emboss is a hard 1px relief with nothing wide for the
  // chat shadow to bury, so it takes the full two-layer lift.
  const shadow = String(usernameStyleCSS({ effect: "emboss" }, "#8ab4ff").textShadow);
  assert.match(shadow, /var\(--chat-shadow\)/,
    "emboss lost the full chat shadow — it has no halo, so it has nothing to protect");
});

// ── Color derivation ─────────────────────────────────────────────────────────

const SAMPLE_COLORS = ["#7dd9a8", "#e697ce", "#8ab4ff", "#ff5e5e", "#333333", "#f5f5f5"];

test("a retired gradient renders as no gradient, never as broken text", () => {
  // "triad" is no longer in the catalog, but an equipped id lives in
  // site.users.username_style and nothing rewrites those rows. The failure to
  // avoid is `background-clip: text` + `color: transparent` with no
  // backgroundImage — an INVISIBLE name. Falling through to the plain colour is
  // the only acceptable degradation, and it is what the else-if chain gives us.
  for (const c of SAMPLE_COLORS) {
    const css = usernameStyleCSS({ gradient: "triad" } as never, c);
    assert.equal(css.backgroundImage, undefined, "a removed gradient still paints");
    assert.notEqual(css.color, "transparent", "a removed gradient left the name invisible");
  }
});

test("every gradient stop clears the 4.5:1 readable clamp", () => {
  // The name is TEXT. A gradient stop that fails contrast is unreadable text,
  // not a decoration — same measurement that kept the composer accent to a
  // border rather than a background tint.
  for (const gradient of ids("gradient")) {
    if (gradient === "rainbow") continue; // fixed palette, not color-derived
    for (const c of SAMPLE_COLORS) {
      const bg = String(usernameStyleCSS({ gradient }, c).backgroundImage);
      for (const stop of bg.match(/#[0-9a-f]{6}/gi) ?? []) {
        // A stop that already clears 4.5:1 is a FIXED POINT of the clamp —
        // readableColor hands it back untouched. One that doesn't gets moved,
        // and the inequality is the failure.
        assert.equal(
          readableColor(stop), stop.toLowerCase(),
          `${gradient} stop ${stop} (from ${c}) fails the 4.5:1 clamp`
        );
      }
    }
  }
});

test("emboss puts one edge lighter and one darker than the fill", () => {
  // This is the assertion that matters, and the reason a preview step exists.
  // Checking only that the two shades are ORDERED is satisfied by two
  // identical-looking dark greens — both edges darker than the fill, on a
  // near-black panel, the whole effect invisible and every test passing.
  // Relief needs a light edge for the BACKGROUND to contrast against and a
  // dark edge for the GLYPH to.
  for (const c of SAMPLE_COLORS) {
    const css = usernameStyleCSS({ effect: "emboss" }, c);
    // Static: no animation, so nothing to fence.
    assert.equal(css.animation, undefined);
    assert.equal(usernameStyleAnimClass({ effect: "emboss" }), "");
    // The fill is left to the caller's own `color`; only a shadow is added.
    assert.equal(css.color, undefined);
    const shades = String(css.textShadow).match(/#[0-9a-f]{6}/gi) ?? [];
    assert.equal(shades.length, 2, `emboss should stack two shades: ${css.textShadow}`);
    const lum = (h: string) => cssColorLuma(h) ?? 0;
    const fill = cssColorLuma(readableColor(c)) ?? 0;
    const [lit, dark] = shades as [string, string];
    assert.ok(lum(lit) >= fill, `the lit edge (${lit}) must not be darker than the fill for ${c}`);
    assert.ok(lum(dark) < fill, `the dark edge (${dark}) must be darker than the fill for ${c}`);
    // Total separation is the property that has to survive the clamps: at the
    // bright end the lit edge runs out of headroom, and the dark edge is
    // required to take up the slack rather than the relief just going flat.
    assert.ok(lum(lit) - lum(dark) > 0.15,
      `relief too flat for ${c}: ${css.textShadow} (Δluma ${(lum(lit) - lum(dark)).toFixed(3)})`);
  }
});

test("an unknown or empty style contributes nothing", () => {
  assert.deepEqual(usernameStyleCSS(null, "#7dd9a8"), {});
  assert.deepEqual(usernameStyleCSS({}, "#7dd9a8"), {});
  assert.deepEqual(usernameStyleCSS({ font: "nope", effect: "nope", gradient: "nope" }, "#7dd9a8"), {});
  assert.equal(usernameStyleAnimClass({ effect: "nope", gradient: "nope" }), "");
});

test("transform effects get the block box transform needs", () => {
  // Named individually on purpose: this is the list the CSS actually depends
  // on, and a transform animation on an inline box silently does nothing.
  for (const id of ["wobble", "bounce", "pop", "jitter"]) {
    assert.ok(ids("effect").includes(id), `"${id}" left the catalog`);
    const css = usernameStyleCSS({ effect: id }, "#7dd9a8");
    assert.equal(css.display, "inline-block", `"${id}" needs display:inline-block`);
    assert.match(String(css.animation), new RegExp(`^un-${id}\\b`));
  }
  const keyframes = cssSrc("../globals.css");
  for (const id of ["bounce", "pop", "jitter"]) {
    const block = new RegExp(`@keyframes\\s+un-${id}\\s*\\{[^}]*\\}[^}]*\\}`).exec(keyframes)?.[0] ?? "";
    assert.ok(block, `no @keyframes un-${id}`);
    // Composited only — a transform-effect keyframe that repaints defeats the
    // point of grouping them (see TRANSFORM_EFFECTS).
    assert.doesNotMatch(block, /text-shadow|background|color|filter/, `un-${id} is not purely transform`);
  }
});

test("the animated set is priced above the static set", () => {
  // The price tier doubles as a second signal that a style adds motion.
  for (const s of USERNAME_STYLES.filter((x) => x.category === "effect")) {
    const animated = /\bun-anim\b/.test(usernameStyleAnimClass({ effect: s.id }));
    assert.equal(s.price >= 500, animated, `"${s.id}" price ${s.price} vs animated=${animated}`);
  }
});

// ── the swashes must have somewhere to go ───────────────────────────────────
//
// A name in `elegant` (Great Vibes) must stay readable: its flourishes leave
// the inline box by up to 0.5em and land on the ":" that follows the name.
//
// The `ink` numbers are worst-case-over-the-alphabet, measured in the browser
// against the real loaded webfonts. These tests pin the CONTRACT, not the
// numbers: that a face known to spill gets room, that the room is PADDING so a
// clipped fill can actually paint the spill (margins leave every gradient
// name's swashes TRANSPARENT — still cut off by the boundaries), that the duo
// ramp is inset so the padding cannot shift its colors off the glyphs, and
// that `ink` and `scale` cannot be conflated.
test("a face whose ink leaves its box is given padding to spill into", () => {
  // The worst case is the FALLBACK until nameInk.ts has measured the actual
  // name; the measured value arrives as --un-ink-l / --un-ink-r.
  const css = usernameStyleCSS({ font: "elegant" }, "#ffffff") as Record<string, unknown>;
  assert.equal(css.paddingInlineEnd, "var(--un-ink-r, 0.67em)",
    "elegant's trailing flourish has no room — it lands on the ':' after the name");
  assert.equal(css.paddingInlineStart, "var(--un-ink-l, 0.28em)", "elegant's leading flourish has no room");
  assert.equal(css.marginInlineEnd, undefined,
    "spill room regressed to margin — background-clip: text cannot paint ink outside the box, " +
    "so every gradient name's swashes render transparent and the name reads as cut off");
});

test("the spill room is inside the paint box, and the duo ramp is inset to compensate", () => {
  // background-clip: text paints only within the element's box. Padding puts
  // the swashes inside it; the stop insets keep the base→to ramp spanning the
  // GLYPH area, so a short name in a wide-spill face doesn't wash toward the
  // ramp's midpoint. The insets read the SAME vars as the padding, so a measured
  // name keeps its ramp on its glyphs.
  const css = usernameStyleCSS(
    { font: "elegant", gradient: "duo", gradientColor: "#302c68" }, "#b7a2f7"
  ) as Record<string, unknown>;
  assert.ok(css.paddingInlineEnd, "the gradient variant lost its spill room");
  // The `to` hex is not asserted literally — readableColor contrast-clamps it.
  assert.match(String(css.backgroundImage),
    /90deg, #b7a2f7 var\(--un-ink-l, 0\.28em\), #[0-9a-f]{6} calc\(100% - var\(--un-ink-r, 0\.67em\)\)/,
    "the duo stops are no longer inset by the ink — the padding now stretches the ramp off the glyphs");
});

test("a spill-free duo face keeps the plain two-stop ramp", () => {
  // No ink → no insets: the gradient must not grow stray "0em" stops.
  const css = usernameStyleCSS(
    { font: "terminal", gradient: "duo", gradientColor: "#302c68" }, "#b7a2f7"
  ) as Record<string, unknown>;
  // The `to` hex is not asserted literally — readableColor contrast-clamps it.
  assert.match(String(css.backgroundImage), /90deg, #b7a2f7, #[0-9a-f]{6}\)/,
    "a face with no measured spill should emit the bare base→to ramp");
});

test("a face that does not spill gets no gap at all", () => {
  // Terminal (VT323) is a strict monospace grid: zero overhang, so adding room
  // would just push the ':' away for no reason.
  const css = usernameStyleCSS({ font: "terminal" }, "#ffffff") as Record<string, unknown>;
  assert.equal(css.paddingInlineStart, undefined, "terminal does not spill and needs no room");
  assert.equal(css.paddingInlineEnd, undefined, "terminal does not spill and needs no room");
});

test("ink and scale are independent — the padding is in em of the SCALED text", () => {
  // If these were ever multiplied together, retuning a face's optical scale
  // would silently change how much room its swashes get, and the next person to
  // adjust one would break the other without touching it.
  // `src()` already strips comments — necessary here, since the prose above the
  // generator explains the relationship in the very terms this scans for.
  const code = src("usernameStyles.ts");
  const gen = code.slice(code.indexOf("if (font.ink?.left)"), code.indexOf("const clipText"));
  assert.doesNotMatch(gen, /ink\.(left|right)\s*\*\s*/,
    "the ink spill is being multiplied by the scale — 1em is already the scaled size");
  assert.doesNotMatch(gen, /font\.scale/, "the spill room must not read the optical scale at all");
});
