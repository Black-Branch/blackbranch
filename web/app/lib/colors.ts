// Shared hex/rgba color helpers. Single source of truth for color parsing in
// the React tree. NOTE: layout.tsx's pre-paint inline <script> keeps its own
// minified copies of these (`_nHex`/`_rgba`) because it runs before any module
// can load — keep them in sync if the logic here changes. Caveat: the script's
// `_rgba` (used for the video/chat/pin/frame vars) assumes a canonical "#rrggbb"
// and skips normalization, so it is a LOOSER mirror than hexToRgba below — safe
// only because every color picker emits 6-digit hex. The glass block does call
// `_nHex` first. If you ever feed pre-paint a 3-digit/loose color, normalize it.

// The username colour for anyone who has not got one — platform chatters whose
// service sent no colour, native users who never opened the picker, and the
// unknown-platform fallback on pins and user cards.
//
// A soft pale grey-blue, just enough to set a name apart from the text: a flat
// neutral grey reads as the same family as the body text, so a name looks like
// a slightly dimmer sentence.
//
// = oklch(84.5% 0.022 255). Held between three neighbours on purpose:
//   • --color-body oklch(92% 0.004 286) — the message text. Separation here is
//     mostly the 7.5pp of lightness; the tint is what makes it read as a NAME
//     rather than as dimmer prose.
//   • the site's own (native) blue #a5c8f7 (chroma ~0.06) — that one is a deliberate
//     platform identity, so the default must stay obviously paler than it.
//   • a neutral grey such as #cccccc — below ~0.02 chroma the tint stops being
//     visible at all next to one.
// A HEX, not a CSS var: every consumer feeds it to
// readableColor()/usernameStyleCSS(), which parse hex and return `raw`
// unchanged for anything else — an oklch() token would silently bypass the
// contrast clamp. Contrast here is 11.9:1 on the chat panel, so the clamp
// passes it through untouched.
export const DEFAULT_NAME_COLOR = "#c3cddb";

// Expand 3-digit hex, strip leading #, return canonical "#rrggbb" or null if invalid.
export function normalizeHex(raw: string): string | null {
  let s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s : null;
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = normalizeHex(hex);
  if (!h) return hex;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return alpha >= 1 ? h : `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

// ---- Minimum-contrast clamp for username colors (Twitch-style) -------------
// Platform chat colors (and older site picks) can land too close to the chat
// panel to read. readableColor() nudges HSL lightness (hue/saturation kept:
// black → readable grey, dark red → lighter red) until the color clears a 4.5:1
// WCAG contrast ratio against the panel — lightening on a dark panel, darkening
// on a light one (the reference tracks the resolved --panel-tint-body background via
// setContrastRefLuma). Render-time only — stored colors are never rewritten.
// Memoized: chat rows re-render constantly (the memo is cleared when the panel
// reference changes).

// The dark page background behind a translucent chat panel — the default
// reference and the surface a semi-transparent panel is composited over.
const PAGE_BG: [number, number, number] = [0x0c, 0x0c, 0x10]; // zinc-950-ish #0c0c10
const APP_BG_LUMA = relLuma(...PAGE_BG);

// The luma the contrast clamp measures against. Defaults to the dark page bg, but
// ChatSidebar/ChatOverlay update it from the *resolved* chat-panel background (see
// setContrastRefLuma) so a user-themed panel — including a light one — clamps names
// against the color they'll actually sit on, not a hard-coded dark constant.
let bgRefLuma = APP_BG_LUMA;

/** Point the username-contrast clamp at the panel background actually being painted.
 *  Clears the memo so already-clamped colors re-resolve against the new reference. */
export function setContrastRefLuma(luma: number): void {
  if (Number.isFinite(luma) && luma !== bgRefLuma) {
    bgRefLuma = luma;
    readableCache.clear();
  }
}

function relLuma(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Relative luminance of a resolved CSS color — the `#rrggbb` or `rgba(r,g,b,a)`
// shapes the theme writes for --panel-tint-body. A translucent panel is composited over
// the dark page bg first, so the reference matches what's actually painted.
export function cssColorLuma(value: string): number | null {
  const v = (value || "").trim();
  let r: number, g: number, b: number, a = 1;
  const m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = (m[1] ?? "").split(",").map((s) => parseFloat(s.trim()));
    r = p[0] ?? NaN;
    g = p[1] ?? NaN;
    b = p[2] ?? NaN;
    if (p.length > 3) a = p[3] ?? 1;
  } else {
    const h = normalizeHex(v);
    if (!h) return null;
    r = parseInt(h.slice(1, 3), 16);
    g = parseInt(h.slice(3, 5), 16);
    b = parseInt(h.slice(5, 7), 16);
  }
  if (![r, g, b].every((c) => Number.isFinite(c))) return null;
  if (a < 1) {
    r = r * a + PAGE_BG[0] * (1 - a);
    g = g * a + PAGE_BG[1] * (1 - a);
    b = b * a + PAGE_BG[2] * (1 - a);
  }
  return relLuma(r, g, b);
}

function contrastOnBg(r: number, g: number, b: number): number {
  const l = relLuma(r, g, b);
  return (Math.max(l, bgRefLuma) + 0.05) / (Math.min(l, bgRefLuma) + 0.05);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 :
    max === g ? ((b - r) / d + 2) / 6 :
                ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)];
}

const readableCache = new Map<string, string>();

export function readableColor(raw: string): string {
  const hex = normalizeHex(raw);
  if (!hex) return raw;
  const cached = readableCache.get(hex);
  if (cached) return cached;
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  let out = hex;
  if (contrastOnBg(r, g, b) < 4.5) {
    const [h, s, l0] = rgbToHsl(r, g, b);
    // Move lightness AWAY from the panel: lighten on a dark panel, darken on a
    // light one.
    //
    // The direction is a property of the PANEL, not of how the two compare.
    // Comparing "is the panel brighter than the text" inverts for a colour
    // DARKER than an already-dark panel: it would darken, and darkening
    // near-black gains nothing — `#000000` would stay invisible.
    const darken = bgRefLuma > 0.5;
    let l = darken ? Math.min(l0, 0.65) : Math.max(l0, 0.35);
    for (let i = 0; i < 20 && contrastOnBg(r, g, b) < 4.5; i++) {
      l = darken ? Math.max(0, l - 0.05) : Math.min(1, l + 0.05);
      [r, g, b] = hslToRgb(h, s, l);
    }
    out = "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");
  }
  readableCache.set(hex, out);
  return out;
}

// ---- Ink for a viewer-chosen button fill ------------------------------------
//
// `--color-on-accent` is a FIXED near-black. That is fine while the accent is
// ours, but the player bar lets a viewer pick their own Donate / Gift / bar
// colours — and a viewer who picks a dark one gets unreadable dark-on-dark.
//
// This is the INVERSE of readableColor(). That one nudges TEXT until it
// contrasts with a known background; here the background is the thing being
// chosen and the text is ours to pick, so the answer is simply which of our two
// inks wins. Two functions because they are two different questions — don't
// collapse them.

/** Near-black / near-white ink, matching --color-on-accent and --color-strong. */
const INK_DARK = "#16161a";
const INK_LIGHT = "#f4f4f5";

function contrastBetween(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The readable ink for a given button fill: whichever of our two inks has more
 * contrast against it. Unparseable input falls back to the dark ink — the
 * existing fixed behaviour — rather than throwing into a style attribute.
 */
export function inkOn(fill: string): string {
  const luma = cssColorLuma(fill);
  if (luma === null) return INK_DARK;
  const dark = cssColorLuma(INK_DARK);
  const light = cssColorLuma(INK_LIGHT);
  if (dark === null || light === null) return INK_DARK;
  return contrastBetween(luma, dark) >= contrastBetween(luma, light) ? INK_DARK : INK_LIGHT;
}
