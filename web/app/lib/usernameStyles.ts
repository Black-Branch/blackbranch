// Username-style catalog (coin store, migrate-v68; reworked twice same week —
// Requirements: styles must integrate the user's OWN name color, then: gradients need
// a USER-PICKED second color, effects should be ANIMATED, fonts must be showy).
// Four combinable categories, each buy-once / equip-free:
//   font     — a display face for the name (self-hosted next/font vars from
//              layout.tsx; deliberately NOT in the free chat-settings list)
//   effect   — static (glow, emboss) or animated (see ANIMATIONS)
//   entrance — plays once as a message arrives (see ARRIVALS)
//   gradient — "duo" blends the name color into a SECOND color the user picks
//              (equipped.gradientColor); "rainbow" is an animated spectrum sweep
// A user equips AT MOST one per category; the equipped set is stored as
// { font?, effect?, entrance?, gradient?, gradientColor? } in site.users.username_style
// and rides chat frames + history. Everything color-derived reads the message's
// usernameColor at RENDER time — change your color and the style follows.
//
// Rendering contract: every derived color passes through readableColor() (the
// 4.5:1 clamp), and animated styles compose ONE inline `animation` list from
// the ANIMATIONS map below (the keyframes live in globals.css). Consumers must
// also apply usernameStyleAnimClass() so prefers-reduced-motion, the "Animate
// name styles" toggle, and the off-screen fence can all reach the animation via
// the .un-anim overrides in globals.css.

import type React from "react";
// `.ts` extension on purpose (allowImportingTsExtensions) — without it
// `node --test` cannot resolve this module's own imports, so nothing in here
// could be tested at all.
import { readableColor, DEFAULT_NAME_COLOR } from "./colors.ts";

export type StyleCategory = "font" | "effect" | "entrance" | "gradient";

export type UsernameStyle = {
  id: string;
  label: string;
  price: number;
  category: StyleCategory;
  /** Off sale: styles nobody wears leave the store, and those who purchased
   *  them keep them. Still renders, still equips for an owner; the store stops
   *  listing it to anyone else and the buy route refuses it. */
  retired?: true;
};

/** Is this style on sale? A retired one only stays visible to its owners. */
export function forSale(s: UsernameStyle): boolean {
  return !s.retired;
}

export const USERNAME_STYLES: readonly UsernameStyle[] = [
  // Fonts (self-hosted Google display faces — vars declared in layout.tsx)
  { id: "gothic",     label: "Blackletter", price: 300, category: "font" },
  { id: "arcade",     label: "Arcade",      price: 300, category: "font" },
  { id: "script",     label: "Script",      price: 300, category: "font" },
  { id: "comic",      label: "Comic",       price: 300, category: "font", retired: true },
  { id: "horror",     label: "Horror",      price: 300, category: "font", retired: true },
  { id: "western",    label: "Western",     price: 300, category: "font", retired: true },
  { id: "street",     label: "Street",      price: 300, category: "font" },
  { id: "cyber",      label: "Cyber",       price: 300, category: "font" },
  { id: "typewriter", label: "Typewriter",  price: 300, category: "font" },
  { id: "imperial",   label: "Imperial",    price: 300, category: "font" },
  { id: "hand",       label: "Handwritten", price: 300, category: "font" },
  { id: "neon",       label: "Neon",        price: 300, category: "font" },
  { id: "terminal",   label: "Terminal",    price: 300, category: "font" },
  { id: "marker",     label: "Marker",      price: 300, category: "font" },
  { id: "elegant",    label: "Elegant",     price: 300, category: "font" },
  { id: "bubble",     label: "Bubble",      price: 300, category: "font", retired: true },
  { id: "stencil",    label: "Stencil",     price: 300, category: "font", retired: true },
  { id: "retro",      label: "Retro",       price: 300, category: "font" },
  { id: "relief",     label: "3D",          price: 300, category: "font", retired: true },
  // Picks from the Name Font Browser.
  { id: "scrawl",     label: "Scrawl",      price: 300, category: "font" },
  { id: "crafty",     label: "Crafty",      price: 300, category: "font" },
  { id: "friendly",   label: "Friendly",    price: 300, category: "font" },
  { id: "brush",      label: "Brush",       price: 300, category: "font" },
  { id: "cursive",    label: "Cursive",     price: 300, category: "font" },
  { id: "rounded",    label: "Rounded",     price: 300, category: "font" },
  { id: "quirky",     label: "Quirky",      price: 300, category: "font" },
  { id: "spray",      label: "Spray Paint", price: 300, category: "font" },
  { id: "fantasy",    label: "Fantasy",     price: 300, category: "font" },
  { id: "calligraphy", label: "Calligraphy", price: 300, category: "font" },
  { id: "notched",    label: "Notched",     price: 300, category: "font" },
  { id: "jersey",     label: "Jersey",      price: 300, category: "font" },
  // Effects. Static ones cost 300, animated ones 500 — the price tier IS the
  // animation tier, so a new effect's price is a second place to notice you
  // are adding motion to every chat row that equips it.
  { id: "glow",       label: "Glow",        price: 300, category: "effect" },
  { id: "emboss",     label: "Embossed",    price: 300, category: "effect" },
  { id: "pulse",      label: "Pulse",       price: 500, category: "effect" },
  { id: "shimmer",    label: "Shimmer",     price: 500, category: "effect" },
  { id: "wobble",     label: "Wobble",      price: 500, category: "effect", retired: true },
  { id: "bounce",     label: "Bounce",      price: 500, category: "effect" },
  { id: "pop",        label: "Pop",         price: 500, category: "effect", retired: true },
  { id: "jitter",     label: "Jitter",      price: 500, category: "effect", retired: true },
  // Picks from the Name Effect Tryout. Still ones first.
  { id: "outline",    label: "Outline",     price: 300, category: "effect" },
  { id: "thick",      label: "Thick outline", price: 300, category: "effect" },
  { id: "longshadow", label: "Long shadow", price: 300, category: "effect" },
  { id: "block",      label: "Block 3D",    price: 300, category: "effect" },
  { id: "slant",      label: "Slanted",     price: 300, category: "effect" },
  { id: "split",      label: "Colour split", price: 300, category: "effect" },
  { id: "squiggle",   label: "Squiggle",    price: 300, category: "effect" },
  { id: "flicker",    label: "Flicker",     price: 500, category: "effect" },
  { id: "glitch",     label: "Glitch",      price: 500, category: "effect" },
  { id: "drift",      label: "Colour drift", price: 500, category: "effect" },
  // Entrances: play ONCE when the message comes in, worn alongside an effect,
  // in their own section. See ARRIVALS.
  { id: "typein",     label: "Type in",     price: 500, category: "entrance" },
  { id: "focusin",    label: "Focus in",    price: 500, category: "entrance" },
  { id: "stamp",      label: "Stamp",       price: 500, category: "entrance" },
  // Gradients
  { id: "duo",        label: "Custom gradient", price: 500, category: "gradient" },
  // No "triad": a gradient that derives three stops from the name colour with
  // nothing for the user to choose reads as a broken "Custom gradient" rather
  // than a style of its own. An equipped id that is no longer in this catalog
  // simply renders no gradient, so removal degrades to the plain name colour.
  { id: "rainbow",    label: "Rainbow",         price: 800, category: "gradient" },
] as const;

// MEMBERSHIP HERE IS WHAT MAKES A STYLE ANIMATED. usernameStyleCSS pushes
// these strings and usernameStyleAnimClass tests the same keys, so a new
// animated style cannot be added in one place and forgotten in the other —
// which is the failure that matters: an animation missing `un-anim` is
// unfenced, unstoppable paint on every chat row, immune to the reduced-motion
// override and to the "Animate name styles" toggle.
// usernameStyles.test.ts proves the two stay equivalent over the whole catalog.
const ANIMATIONS: Record<string, string> = {
  rainbow: "un-rainbow 5s linear infinite",
  pulse:   "un-pulse 1.8s ease-in-out infinite",
  shimmer: "un-shimmer 2.6s linear infinite",
  wobble:  "un-wobble 1.6s ease-in-out infinite",
  bounce:  "un-bounce 1.5s ease-in-out infinite",
  pop:     "un-pop 1.7s ease-in-out infinite",
  // `steps(3)`, not `steps(3, end)` — `end` is the default, and a comma inside
  // a value that gets comma-joined into the `animation` shorthand is a trap for
  // every naive reader of that string, this file's own tests included.
  jitter:  "un-jitter 1.2s steps(3) infinite",
  flicker: "un-flicker 3.2s linear infinite",
  glitch:  "un-glitch 3.5s step-end infinite",
  drift:   "un-drift 4s ease-in-out infinite",
  // Arrivals — ONE iteration, `backwards` so the start frame holds through any
  // delay and the element is left untouched afterwards. Still in this map so
  // the fence and both motion switches reach them.
  typein:  "un-typein 0.7s steps(var(--un-n, 10)) backwards",
  focusin: "un-focusin 0.7s ease-out backwards",
  stamp:   "un-stamp 0.45s ease-out backwards",
};

// Plays once, on arrival. The entrance rides its own custom property,
// `--un-enter`, at the END of the animation list, so globals.css can switch off
// the entrance alone on every HISTORY row when chat loads (only a row that
// arrived live, .chat-msg-in, plays one) while the effect worn with it keeps
// running. `.un-arrive` marks the element for that rule.
const ARRIVALS = new Set(["typein", "focusin", "stamp"]);

// Effects animated purely by `transform`. Grouped because they share both a
// requirement and a virtue: transform does nothing to an inline box (hence the
// display switch), and it is composited — unlike pulse/shimmer, which repaint
// the glyphs every frame and are the reason the fence had to exist at all.
const TRANSFORM_EFFECTS = new Set(["wobble", "bounce", "pop", "jitter", "glitch"]);

// `scale` normalizes every face so a styled name FEELS the same size as a plain
// one (the store previews them at a glance — a face that renders visibly
// bigger/smaller is a surprise at purchase). The rule lives in ONE place,
// scaleFor in usernameFontMetrics.ts; usernameStyles.test.ts recomputes every
// scale (and every `wordSpacing`) from the measurements, so a number here can
// only move by re-measuring.
//
// NOT bounded by the line box. That bound pins the scripts small (`elegant`
// would render its x-height at 0.72 of a plain name, unreadable), so names may
// OVERLAP their box. Nothing clips them in chat — no overflow or max-height on
// .chat-msg-row or .chat-msg-body — and the lineHeight division below keeps
// the ROW's height fixed, so a tall face overlaps its neighbours rather than
// pushing them apart.
//
// Measured in the browser against the real loaded webfonts (canvas TextMetrics
// at 400px, reference Geist @600) with `web/scripts/measure-username-scales.js`,
// which also prints the `ink` fallback below. Every face is verified to have
// actually loaded (distinct 'Handgloves' widths) — otherwise a run can
// silently measure the metric-override FALLBACK for most faces.
//
// ── `ink`: how far the glyphs spill SIDEWAYS out of their own box ───────────
//
// Script swashes really do leave the inline box, and the ":" follows the name
// immediately, so a script name needs room to stay readable.
//
// These are the WORST CASE over [a-zA-Z0-9_], at weight 600 — and only the
// FALLBACK used until the face has loaded. The worst case reserves room for a
// curly T or j that most names don't have: at chat size `elegant` would put
// 24px after the badge and 13px before the colon, where a plain name has 12
// and 1–2. nameInk.ts measures the WHOLE actual name once the face is in and
// sets --un-ink-l/--un-ink-r. Whole name, not its first and last letter: a
// later letter's swash can reach back past the first one (measured — Elegant
// "WAVEgg" touches the badge under a first/last-letter rule).
//
// Only faces spilling ≥0.03em carry a value; below that it rounds to nothing at
// chat sizes and would only add a gap nobody asked for.
const FONT_STACKS: Record<string, {
  family: string;
  scale?: number;
  /** Extra space between words, in em of the SCALED name — see wordSpacingFor
   *  (usernameFontMetrics.ts). Derived; the test recomputes it. */
  wordSpacing?: number;
  /** Worst-case sideways ink spill, in em of the FACE (before `scale`). Only
   *  the FALLBACK until the face loads — nameInk.ts then measures the actual
   *  name (see the ink block in usernameStyleCSS). */
  ink?: { left?: number; right?: number };
}> = {
  gothic:     { family: `var(--font-pirata), serif`,            scale: 1.03, wordSpacing: 0.05, ink: { left: 0.08, right: 0.09 } },
  arcade:     { family: `var(--font-press-start), monospace`,   scale: 0.72, wordSpacing: -0.66 },
  script:     { family: `var(--font-pacifico), cursive`,        scale: 1.04, wordSpacing: -0.02, ink: { left: 0.25, right: 0.24 } },
  comic:      { family: `var(--font-bangers), sans-serif`,      scale: 1.04, wordSpacing: 0.04, ink: { left: 0.08, right: 0.18 } },
  horror:     { family: `var(--font-creepster), sans-serif`,    scale: 1.04, ink: { left: 0.06, right: 0.06 } },
  western:    { family: `var(--font-rye), serif`,               scale: 0.97, wordSpacing: 0.01, ink: { left: 0.16, right: 0.15 } },
  street:     { family: `var(--font-bungee), sans-serif`,       scale: 0.98, wordSpacing: 0.02 },
  cyber:      { family: `var(--font-audiowide), sans-serif`,    scale: 1.03, wordSpacing: -0.09, ink: { left: 0.23, right: 0.05 } },
  typewriter: { family: `var(--font-special-elite), monospace`, scale: 1.07, wordSpacing: -0.06, ink: { left: 0.05, right: 0.1 } },
  imperial:   { family: `var(--font-cinzel), serif`,            scale: 0.96, ink: { left: 0.05, right: 0.48 } },
  hand:       { family: `var(--font-caveat), cursive`,          scale: 1.4, wordSpacing: -0.07, ink: { left: 0.09, right: 0.22 } },
  neon:       { family: `var(--font-monoton), sans-serif`,      scale: 0.9, wordSpacing: 0.16, ink: { right: 0.03 } },
  terminal:   { family: `var(--font-vt323), monospace`,         scale: 1.33, wordSpacing: -0.22 },
  marker:     { family: `var(--font-permanent-marker), cursive`, scale: 0.96, wordSpacing: -0.14, ink: { left: 0.17, right: 0.21 } },
  elegant:    { family: `var(--font-alex-brush), cursive`,      scale: 1.19, wordSpacing: 0.01, ink: { left: 0.28, right: 0.67 } },
  bubble:     { family: `var(--font-chewy), sans-serif`,        scale: 1.04, ink: { left: 0.19, right: 0.1 } },
  stencil:    { family: `var(--font-black-ops), sans-serif`,    scale: 1.07, wordSpacing: -0.03, ink: { left: 0.08, right: 0.07 } },
  retro:      { family: `var(--font-bowlby), sans-serif`,       scale: 0.94, wordSpacing: -0.09, ink: { left: 0.05, right: 0.07 } },
  relief:     { family: `var(--font-rampart), sans-serif`,      scale: 1.03, wordSpacing: -0.08, ink: { left: 0.11, right: 0.07 } },
  // Picks from the Name Font Browser.
  scrawl:     { family: `var(--font-gloria), cursive`,          scale: 1.02, wordSpacing: -0.21, ink: { left: 0.23, right: 0.05 } },
  crafty:     { family: `var(--font-crafty), cursive`,          scale: 0.99, wordSpacing: -0.13, ink: { left: 0.31, right: 0.15 } },
  friendly:   { family: `var(--font-shantell), sans-serif`,     scale: 1.03, wordSpacing: -0.11, ink: { left: 0.05, right: 0.08 } },
  brush:      { family: `var(--font-kaushan), cursive`,         scale: 1.08, wordSpacing: -0.02, ink: { left: 0.23, right: 0.33 } },
  cursive:    { family: `var(--font-sofia), cursive`,           scale: 1.11, wordSpacing: -0.13, ink: { left: 0.2, right: 0.26 } },
  rounded:    { family: `var(--font-name-comfortaa), sans-serif`,    scale: 0.94, wordSpacing: -0.03, ink: { left: 0.11, right: 0.06 } },
  quirky:     { family: `var(--font-barriecito), sans-serif`,   scale: 1, wordSpacing: -0.02, ink: { left: 0.08, right: 0.04 } },
  spray:      { family: `var(--font-lacquer), sans-serif`,      scale: 1.1, wordSpacing: -0.16 },
  fantasy:    { family: `var(--font-metamorphous), serif`,      scale: 0.94, wordSpacing: -0.07, ink: { left: 0.06, right: 0.06 } },
  calligraphy:{ family: `var(--font-quintessential), cursive`,  scale: 1.07, wordSpacing: -0.02, ink: { left: 0.3, right: 0.16 } },
  notched:    { family: `var(--font-nova-cut), sans-serif`,     scale: 0.99, wordSpacing: -0.14, ink: { left: 0.03, right: 0.03 } },
  jersey:     { family: `var(--font-jersey), sans-serif`,       scale: 1.19, wordSpacing: -0.04, ink: { right: 0.03 } },
};

/** The CSS font stack a name font renders in (null for an unknown id) — for
 *  nameInk.ts, which needs the face itself to measure the actual name. */
export function nameFontFamily(id: string): string | null {
  return FONT_STACKS[id]?.family ?? null;
}

export function styleById(id: string): UsernameStyle | null {
  return USERNAME_STYLES.find((s) => s.id === id) ?? null;
}

/** Shape stored in site.users.username_style / carried on chat frames. */
export type EquippedStyle = {
  font?: string | null;
  effect?: string | null;
  /** Plays once as the message arrives; worn alongside an effect. */
  entrance?: string | null;
  gradient?: string | null;
  /** Second stop for the "duo" gradient — the user's own pick (hex). */
  gradientColor?: string | null;
};

/**
 * What the equipped set becomes if `style` is swapped into its category — the
 * set a preview tile should render.
 *
 * A tile that previews its style ALONE (`{ [category]: id }`) shows a different
 * name from the one you would get: with a custom font and/or gradient selected,
 * the stackable tiles must show what it would look like. The categories STACK,
 * so an effect shown on the default face is not a preview of anything the user
 * can have — and it also makes the effect tiles render visibly larger than the
 * font tiles, because a bare effect carries no `scale` and falls back to the
 * unscaled default face.
 *
 * Spreading `base` is what carries `gradientColor` — the duo tile without it
 * previews against the white default rather than the colour actually picked.
 */
export function previewStyleSet(
  base: EquippedStyle | null | undefined,
  style: { id: string; category: StyleCategory }
): EquippedStyle {
  return { ...(base ?? {}), [style.category]: style.id };
}

/**
 * The four categories in display order, with the headings every picker shows.
 *
 * Shared so the profile editor and the store cannot label or order them
 * differently — a viewer meets the same styles twice and a category that is
 * "Effects" in one place and "Animations" in the other reads as two catalogues.
 */
export const STYLE_GROUPS: readonly { category: StyleCategory; label: string }[] = [
  { category: "font", label: "Fonts" },
  { category: "effect", label: "Effects" },
  { category: "entrance", label: "Entrances" },
  { category: "gradient", label: "Gradients" },
] as const;

// ── Color derivation (hex → HSL → hex) ──────────────────────────────────────

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6
    : max === g ? ((b - r) / d + 2) / 6
    : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 1) + 1) % 1;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${to(f(hue + 1 / 3))}${to(f(hue))}${to(f(hue - 1 / 3))}`;
}

/** The base at a different lightness, hue and saturation kept. */
function shiftL(base: string, delta: number, lo = 0.06, hi = 0.96): string {
  const hsl = hexToHsl(base);
  if (!hsl) return base;
  const [h, s, l] = hsl;
  return hslToHex(h, s, Math.min(hi, Math.max(lo, l + delta)));
}

/**
 * The lit and dark edges of the emboss effect.
 *
 * Whatever one side loses to the ceiling or the floor, the OTHER side takes
 * on. Clamping each edge independently silently flattens the effect at the ends
 * of the range: a near-white name has no room to go lighter, so both edges
 * collapse onto the fill and the relief disappears for exactly the users who
 * picked the brightest color. Redistributing keeps the total contrast constant
 * across every pick.
 */
function embossEdges(base: string): [string, string] {
  const hsl = hexToHsl(base);
  if (!hsl) return [base, base];
  const l = hsl[2];
  let up = l + 0.3, down = l - 0.32;
  if (up > 0.96) { down -= up - 0.96; up = 0.96; }
  if (down < 0.06) { up = Math.min(0.96, up + (0.06 - down)); down = 0.06; }
  return [shiftL(base, up - l), shiftL(base, down - l)];
}

/** Fallback duo stop while the user hasn't picked one: lighten toward white.
 *  Keeps its own 0.92 ceiling — it is a shipped style and users own it. */
const defaultDuoStop = (base: string) => shiftL(base, 0.35, 0, 0.92);


// Periodic (starts and ends on the same color) so the 200%-wide background can
// loop seamlessly; stops picked bright enough for the dark theme.
const RAINBOW =
  "linear-gradient(90deg, #ff5e5e, #ffb75e, #ffe75e, #6ee76e, #5ec4ff, #b18cff, #ff5ee1, #ff5e5e)";

// The row's own chat shadow, so an effect that sets `textShadow` can append it
// instead of erasing it (S-11). Reading the var keeps this following the
// Shadow toggle and its two sliders — including `none`, which is a valid
// text-shadow layer and simply contributes nothing.
const CHAT_SHADOW = "var(--chat-shadow)";

// The CONTACT layer alone — the tight drop, at a radius that does NOT follow the
// blur slider. For effects that already lift themselves off the background and
// only need the contact shade.
//
// Appending the FULL shadow to glow washes it out: the wide layer is 12px ×
// blur — up to 36px of near-opaque black behind a halo that is a fixed 14px.
// Past about 1× the shadow is wider than the effect it sits under and swallows
// it, so the further you push Shadow the less glow you have — and the only
// lever left is the GLOBAL shadow, so rescuing one purchased effect costs
// every other name in chat its lift.
const CHAT_SHADOW_CONTACT = "var(--chat-shadow-contact)";

// The same two shadows as CHAT_SHADOW, pre-expressed as drop-shadow() filters.
// Needed because a `text-shadow` cannot be wrapped in `drop-shadow()` (it is a
// comma list; the filter takes one shadow per function), and a gradient name
// must use the filter form — see clipText.
const CHAT_SHADOW_FILTER = "var(--chat-shadow-filter)";

/**
 * "un-anim" when the equipped set animates, else "" — consumers append it to
 * className so the prefers-reduced-motion override in globals.css applies.
 */
export function usernameStyleAnimClass(style: EquippedStyle | null | undefined): string {
  if (!style) return "";
  const animated =
    (!!style.effect && style.effect in ANIMATIONS) ||
    (!!style.entrance && ARRIVALS.has(style.entrance)) ||
    (!!style.gradient && style.gradient in ANIMATIONS);
  if (!animated) return "";
  return style.entrance && ARRIVALS.has(style.entrance) ? "un-anim un-arrive" : "un-anim";
}

/**
 * CSS for the equipped style set, composed onto the message's own name color.
 * Spread AFTER the base `color`. Malformed/unknown ids contribute nothing.
 */
export function usernameStyleCSS(
  style: EquippedStyle | null | undefined,
  baseColor: string | null | undefined
): React.CSSProperties {
  if (!style || (!style.font && !style.effect && !style.entrance && !style.gradient)) return {};
  const base = readableColor(baseColor || DEFAULT_NAME_COLOR);
  const css: React.CSSProperties = {};
  const anims: string[] = [];
  // Effect shadow layers, collected rather than written straight to
  // `textShadow`, because a gradient name has to emit them as drop-shadow()
  // filters instead (see clipText) and a comma-joined string cannot be taken
  // back apart — rgba() has commas in it too.
  const shadow: string[] = [];
  // Which global chat shadow to append. "contact" is the tight layer alone, for
  // an effect that already lifts itself and would be buried by the wide one.
  // Null means "set nothing and inherit", which is what a plain name in a chat
  // row wants.
  let tail: "full" | "contact" | null = null;
  // Hollow (outline): like a clipped fill, a text-shadow would draw the WHOLE
  // glyph and fill the hollow back in — so it takes drop-shadow filters too.
  let hollow = false;
  // Colour drift: hue-rotate composed in FRONT of whatever filter the name has.
  let drift = false;

  const font = style.font ? FONT_STACKS[style.font] : undefined;
  if (font) {
    css.fontFamily = font.family;
    if (font.scale) {
      css.fontSize = `${font.scale}em`;
      // DIVIDED BY THE SCALE, and the division is load-bearing — same reason
      // the cipher span divides (globals.css, .chat-cipher). A unitless
      // line-height multiplies the element's OWN font-size, so a name at 1.33em
      // would otherwise claim a 1.4 × 1.33 = 1.86em line box and make its row
      // visibly taller than every row around it. Dividing gives
      // (1.4 / 1.33) × 1.33em = 1.4em of the ROW: the name sits in the reader's
      // own line box whatever face it wears, and the scale stays free to be
      // whatever optical matching actually needs.
      css.lineHeight = `calc(var(--chat-line-height, 1.4) / ${font.scale})`;
    }
    // Give the swashes somewhere to go — as PADDING, not margin. Margin and
    // padding are identical for inline flow (the ":" separator and the badges
    // move the same either way), but they differ in exactly the way that
    // matters for the gradient styles: `background-clip: text` can only paint
    // ink that lies INSIDE the element's box, so with margins the very swashes
    // the ink table measures fall outside the box and render TRANSPARENT — an
    // invisible flourish on every gradient name in a spilling face. Padding
    // puts the spill inside the paintable box. The gradient-geometry cost of
    // padding is handled where the gradient is built — see the duo stop insets
    // below.
    //
    // In em of the SCALED text, so `ink` (per-face) and `scale` (optical
    // matching) stay independent: retuning one must never silently change the
    // other. `1em` here is already the scaled size, so the raw face value is
    // exactly right without multiplying by `scale`.
    //
    // The value is a var with the worst case as its fallback: nameInk.ts
    // replaces it with this name's own measured spill once the face has loaded.
    if (font.ink?.left) css.paddingInlineStart = `var(--un-ink-l, ${font.ink.left}em)`;
    if (font.ink?.right) css.paddingInlineEnd = `var(--un-ink-r, ${font.ink.right}em)`;
    // A space as wide as a plain name's.
    if (font.wordSpacing) css.wordSpacing = `${font.wordSpacing}em`;
  }

  // Gradient layer first — shimmer stacks its highlight band on top of it.
  //
  // CLIPPING THE FILL INVERTS THE PAINT ORDER FOR SHADOWS. CSS paints an
  // element's background, THEN its text-shadow, THEN its text — which is why a
  // shadow normally sits behind a glyph: the glyph is opaque and covers it.
  // `background-clip: text` + `color: transparent` moves the fill into the
  // BACKGROUND and leaves the text itself invisible, so the shadow paints ON TOP
  // of the gradient instead of behind it.
  //
  // Two visible bugs, one cause: the chat shadow smears black over every
  // gradient name, and glow's halo paints its colour over the whole glyph, so
  // retuning the halo colour reads as "the glow changed my username colour".
  //
  // A gradient name therefore takes its shadows as `filter: drop-shadow(...)`,
  // which applies to the composited result — fill included — and lands behind.
  let clipped = false;
  const clipText = () => {
    css.backgroundClip = "text";
    css.WebkitBackgroundClip = "text";
    css.color = "transparent";
    // The clipped fill paints only INSIDE the box, and in a flex row (cards,
    // store tiles, chat) this span is blockified to one line at line-height ≈ 1
    // — so every descender and tall cap would be cut flat (a "j"). The padding
    // makes the paintable box tall enough; the equal negative margin gives the
    // room back, so nothing around the name moves. (Inline, vertical padding and
    // margin do not affect layout at all.)
    css.paddingBlock = "0.35em";
    css.marginBlock = "-0.35em";
    clipped = true;
  };
  if (style.gradient === "duo") {
    const to = readableColor(style.gradientColor || defaultDuoStop(base));
    // The stops are inset by the face's ink padding, so the base→to ramp
    // spans the GLYPH area exactly (the background box includes the padding —
    // see the ink block above). Without the insets a short name in a
    // wide-spill face samples only the middle of the ramp and washes toward the
    // midpoint. The padding strips clamp flat to the end colors, which is
    // exactly right for the ink that spills into them: a first-glyph swash
    // wears the first glyph's color.
    // The same vars as the padding, so a measured name keeps its ramp on its glyphs.
    const inkL = style.font ? FONT_STACKS[style.font]?.ink?.left : undefined;
    const inkR = style.font ? FONT_STACKS[style.font]?.ink?.right : undefined;
    css.backgroundImage = `linear-gradient(90deg, ${base}${inkL ? ` var(--un-ink-l, ${inkL}em)` : ""}, ${to}${inkR ? ` calc(100% - var(--un-ink-r, ${inkR}em))` : ""})`;
    clipText();
  } else if (style.gradient === "rainbow") {
    // No ink insets here or in shimmer, on purpose: both animate their
    // background across the box, so there is no stable anchoring for a
    // sub-em padding to disturb — only duo has a fixed ramp worth preserving.
    css.backgroundImage = RAINBOW;
    css.backgroundSize = "200% 100%";
    clipText();
    anims.push(ANIMATIONS.rainbow!);
  }

  // An effect that sets `textShadow` must APPEND the chat shadow, not replace
  // it. These are inline styles, so they beat `.chat-msg-row`'s
  // `text-shadow: var(--chat-shadow)` outright — and a replacing glow/emboss
  // name would be the one name in the list sitting flat on the theme while
  // every plain name around it is lifted off it. Inconsistency BETWEEN rows
  // reads as a rendering bug in a way that "no shadow anywhere" never does.
  // `text-shadow` is a comma list, so appending is all it takes; the effect
  // still paints first (earlier layers sit on top).
  if (style.effect === "glow") {
    // A GLOW IS LIGHT, NOT MORE INK. A halo in the glyph's own colour at FULL
    // opacity, 6px out, has zero contrast with the glyph: the blur fills the
    // counters, and the letterforms dissolve into their own bloom — washing
    // out the username.
    //
    // Two changes, both about separating the glyph from its halo:
    //   • the outer halo is LIGHTER than the glyph, because that is what light
    //     does as it intensifies, and it is the only axis with contrast left — a
    //     darker halo is a shadow, and the same colour is no contrast.
    //   • it is tighter (4px) and not opaque, so the near layer hugs the strokes
    //     instead of pouring into the gaps between them.
    //
    // NOT the global shadow — appending the full shadow here buries the halo
    // under up to 36px of black. The contact layer alone, at a radius the blur
    // slider cannot move.
    // The NEAR layer keeps the glyph's own colour: lightening it reads as a
    // change of the entire username colour, because on a gradient name the
    // halo paints OVER the fill — see clipText — and even on a plain one a
    // lighter corona hugging the strokes shifts the whole impression. Only the
    // outer bloom lightens, which is where light actually disperses. The
    // washout fix that matters is the OPACITY: an opaque 6px halo of any colour
    // fills the counters.
    shadow.push(`0 0 4px ${base}8c`, `0 0 13px ${shiftL(base, 0.22)}59`);
    tail = "contact";
  } else if (style.effect === "emboss") {
    // Static relief: a LIT edge above-left and a dark edge below-right, both
    // shades of the user's own color. No keyframes, no fence, nothing to pause.
    //
    // Both edges darker does not work, however sound the depth reasoning
    // sounds: two progressively darker shades are correct for a light page and
    // completely invisible here, where the panel is already near-black and a
    // dark shadow on it has nothing to contrast against — and a test that only
    // checks the two shades are ordered never sees it. The light edge is the
    // half that reads on a dark panel; the dark edge reads against the glyph
    // itself. That is why it must be one of each.
    const [lit, dark] = embossEdges(base);
    shadow.push(`-1px -1px 0 ${lit}`, `1px 1px 0 ${dark}`);
    tail = "full";
  } else if (style.effect === "pulse") {
    // Keyframes read --un-c; the breathing halo sits behind the glyphs, so it
    // shows through even when a gradient makes the fill transparent.
    (css as React.CSSProperties & { "--un-c"?: string })["--un-c"] = base;
    anims.push(ANIMATIONS.pulse!);
  } else if (style.effect === "shimmer" && style.gradient !== "rainbow") {
    // A white gleam sweeping over the fill (solid color or the duo gradient).
    // Skipped under rainbow — both would fight over background-position.
    // The skip is safe for the fence only because rainbow is ITSELF animated,
    // so the equipped set still earns `un-anim`. usernameStyles.test.ts pins it.
    const under = css.backgroundImage ?? `linear-gradient(${base}, ${base})`;
    css.backgroundImage =
      `linear-gradient(110deg, transparent 38%, rgba(255,255,255,0.9) 50%, transparent 62%), ${under}`;
    css.backgroundSize = "250% 100%, 100% 100%";
    css.backgroundPosition = "200% 0, 0 0";
    clipText();
    anims.push(ANIMATIONS.shimmer!);
  } else if (style.effect === "outline") {
    // Hollow: the fill goes, a thin stroke in the name's own colour stays. On a
    // gradient name the clipped fill still shows inside the stroke — a filled
    // outline, which is the only reading a gradient + outline can have.
    if (!clipped) css.color = "transparent";
    css.WebkitTextStroke = `0.06em ${base}`;
    hollow = true;
    tail = "contact";
  } else if (style.effect === "thick") {
    // A dark border UNDER the fill (paint-order), so the letters keep their
    // weight instead of the stroke eating half of every stem.
    // Not on a gradient name: its fill is the clipped BACKGROUND, painted
    // before any stroke, so paint-order cannot put the stroke under it and the
    // stroke covers the inner half of every stem. There the border is four
    // tight drop-shadows instead — behind the fill by nature.
    const edge = shiftL(base, -0.45);
    if (clipped) shadow.push(`0.06em 0 0 ${edge}`, `-0.06em 0 0 ${edge}`, `0 0.06em 0 ${edge}`, `0 -0.06em 0 ${edge}`);
    else { css.WebkitTextStroke = `0.16em ${edge}`; css.paintOrder = "stroke fill"; }
    tail = "full";
  } else if (style.effect === "longshadow") {
    // A stepped diagonal in darker shades of the name's colour — hard edges, no
    // blur, so it reads as a retro sign rather than a soft drop.
    // Fixed px, as in the tryout it was picked from: em steps grow with the face
    // and the preview zoom until the shadow runs over the tile's caption.
    // On a gradient name the layers become drop-shadow() FILTERS, which
    // chain: each shadows everything before it, so absolute 1..5px steps would
    // sum to 15px. There each step is the 1px DELTA instead.
    for (let i = 1; i <= 5; i++) {
      const d = clipped ? 1 : i;
      shadow.push(`${d}px ${d}px 0 ${shiftL(base, -0.3 - i * 0.03)}`);
    }
    tail = "contact";
  } else if (style.effect === "block") {
    // Letters standing up off the page: stacked straight-down layers, then one
    // soft shadow under the stack.
    // Fixed px, same reason as the long shadow.
    // Deltas on a gradient name, same reason as the long shadow: the soft
    // shadow then sits 2px under a stack that already reaches 4px.
    for (let i = 1; i <= 4; i++) shadow.push(`0 ${clipped ? 1 : i}px 0 ${shiftL(base, -0.18 - i * 0.07)}`);
    shadow.push(`0 ${clipped ? 2 : 6}px 6px rgba(0,0,0,0.6)`);
  } else if (style.effect === "slant") {
    // Static lean. transform needs a block-ish box, same as the motion effects.
    css.display = "inline-block";
    css.transform = "skewX(-10deg)";
  } else if (style.effect === "split") {
    // A misprint: red and cyan edges either side. Fixed hues on purpose — the
    // effect IS the two colours, whatever the name wears.
    shadow.push("-0.07em 0 rgba(255,43,109,0.85)", "0.07em 0 rgba(43,242,255,0.85)");
    tail = "full";
  } else if (style.effect === "squiggle") {
    css.textDecorationLine = "underline";
    css.textDecorationStyle = "wavy";
    css.textDecorationColor = base;
    css.textDecorationThickness = "0.08em";
    css.textUnderlineOffset = "0.2em";
  } else if (style.effect === "flicker") {
    // A neon sign that sputters: a soft halo, and opacity dips in the keyframes
    // (opacity is composited — the cheapest thing that can move).
    shadow.push(`0 0 0.3em ${base}8c`);
    tail = "contact";
    anims.push(ANIMATIONS.flicker!);
  } else if (style.effect === "drift") {
    // The name's colour slowly shifts shade and back: a registered --un-h angle
    // animates, and hue-rotate reads it (composed into the filter below, so a
    // gradient name keeps its drop-shadows).
    drift = true;
    anims.push(ANIMATIONS.drift!);
  } else if (style.effect && TRANSFORM_EFFECTS.has(style.effect)) {
    // transform is a no-op on an inline box, so these need a block-ish one.
    // The name keeps its inline flow either way — transform never reflows, so
    // nothing around it moves however far the glyphs travel.
    css.display = "inline-block";
    anims.push(ANIMATIONS[style.effect]!);
  }

  // ── Emit the shadows, in the form this fill can actually use ──────────────
  //
  // A CLIPPED FILL TAKES FILTERS, NOT text-shadow. With
  // `background-clip: text` the glyph colour lives in the BACKGROUND and the
  // text itself is transparent, so a text-shadow paints on top of the fill
  // rather than behind it. `textShadow: "none"` is load-bearing here: it blocks
  // the row's INHERITED `--chat-shadow`, which would smear black over every
  // gradient name. drop-shadow() applies to the composited element, fill
  // included.
  //
  // A plain name with no effect deliberately sets NOTHING and inherits the
  // row's shadow — setting an equivalent value here would silently detach it
  // from the reader's shadow settings.
  if (clipped || hollow) {
    css.textShadow = "none";
    css.filter = [
      ...shadow.map((l) => `drop-shadow(${l})`),
      tail === "contact" ? `drop-shadow(${CHAT_SHADOW_CONTACT})` : CHAT_SHADOW_FILTER,
    ].join(" ");
  } else if (shadow.length) {
    css.textShadow = [...shadow, tail === "contact" ? CHAT_SHADOW_CONTACT : CHAT_SHADOW].join(", ");
  }
  if (drift) css.filter = `hue-rotate(var(--un-h, 0deg))${css.filter ? ` ${css.filter}` : ""}`;
  // Glitch's colour split lives in its keyframes as drop-shadow FILTERS — a
  // keyframe text-shadow paints over a clipped gradient fill.
  // The keyframes need the name's own filter to add to and return to, so it
  // rides --un-f. `saturate(1)` is the identity for a name with no filter.
  if (style.effect === "glitch") {
    (css as React.CSSProperties & { "--un-f"?: string })["--un-f"] = css.filter ?? "saturate(1)";
    css.filter = "var(--un-f)";
  }

  // The entrance goes LAST, through --un-enter (see ARRIVALS). Last also means
  // its transform wins over an effect's for the moment it plays.
  if (style.entrance && ARRIVALS.has(style.entrance)) {
    (css as React.CSSProperties & { "--un-enter"?: string })["--un-enter"] = ANIMATIONS[style.entrance]!;
    anims.push("var(--un-enter)");
    // Stamp scales (an inline box ignores transform) and Type in clips to the
    // box — both want a block-ish one, as they had in the effect slot.
    if (style.entrance !== "focusin") css.display = "inline-block";
  }
  if (anims.length) css.animation = anims.join(", ");
  return css;
}
