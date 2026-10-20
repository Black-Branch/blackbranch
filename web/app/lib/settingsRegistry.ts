// Single source of truth for chat/appearance settings.
//
// Each setting is one entry: its localStorage key, parse/serialize, the
// CSS-var/class side-effect, and the control metadata used to render it in the
// settings menu. Hydration, apply-on-change, reset, the DB save blob, and the
// rendered menu are ALL driven by this registry — adding a setting is one entry
// (plus, for a setting flagged `prePaint: true`, a matching restore line in the
// layout.tsx pre-paint <script>, whose value guard should mirror this entry's
// `parse`). scripts/check-prepaint.mjs — wired into `npm run build` — enforces the
// mirror both ways: a missing restore (flash-on-reload) OR an orphaned/typo'd key
// both fail the build.
//
// Behavior is intentionally identical to the previous hand-written ChatSettings:
// the effect bodies below are the old apply functions, relocated verbatim.

import { chatFontCalc } from "./chatFont";
import { hexToRgba, inkOn, readableColor } from "./colors";
import { lsGet, lsSet } from "./safeLocalStorage";
import { emoteSizingChanged } from "./emoteRes";
import { deviceClass } from "./deviceClass";
import { pageGradient, BG_DIRS, type BgDir } from "./panelColours";
import { BRAND_PLATFORM_COLORS } from "./platformColors";
import { siteName } from "./siteName";
import { tsIndentWidth, TS_FORMATS, type TsFormat } from "./chatTime";
import { measureTsWidth } from "./tsMeasure";
import { MENTION_SOUNDS, playMentionSound, type MentionSound } from "./mentionSound";
import type { HistoryLength } from "./chatCaps";

// ─── overlay settings scope ───────────────────────────────────────────────────
// Two pages keep their appearance in an isolated keyspace ("ov:"): /chat (the
// streamer's own chat window) and /overlay/chat (the OBS browser source).
// Tuning either never touches the site chat (write-isolation) and vice versa.
// Reads fall back to the site value and lazily seed the scoped key, so the page
// starts looking like the site then becomes fully independent after first
// paint. The prepaint <script> in app/layout.tsx mirrors this shadowing before
// hydration (keep the two in sync: same pathname list, same "ov:" prefix, same
// lazy-seed-on-read — overlayScope.test.ts pins the list). Scope is ""
// everywhere else. The two pages SHARE the one keyspace: in one browser profile
// the window and the OBS source look the same — OBS has its own profile, so in
// practice they differ.
export function settingsScope(): string {
  if (typeof window === "undefined") return "";
  const p = window.location?.pathname;
  return p === "/chat" || p === "/overlay/chat" ? "ov:" : "";
}
export const isOverlayScope = (): boolean => settingsScope() !== "";
/** Scope-aware read of a settings ls-key (with lazy seed from the site value on the overlay). */
export function settingGet(lsKey: string): string | null {
  const sc = settingsScope();
  // Behavior with no control on the overlay pages follows the site LIVE — a seeded
  // copy there would be frozen forever (half-A review I4). SITE_SCOPED_LS is below.
  if (!sc || SITE_SCOPED_LS.has(lsKey)) return lsGet(lsKey);
  const scoped = lsGet(sc + lsKey);
  if (scoped != null) return scoped;
  const base = lsGet(lsKey);                    // pre-seed fallback → no flash
  if (base != null) lsSet(sc + lsKey, base);    // lazy one-time seed → independence
  return base;
}
/** Scope-aware write of a settings ls-key. */
export function settingSet(lsKey: string, value: string): void {
  lsSet(settingsScope() + lsKey, value);
}

// ─── scale helpers (text-size slider is non-linear: 0–100 ↔ rem) ──────────────
export const MIN_REM = 0.65;
export const MAX_REM = 2.0;
// 1.352, not 1.35, so the slider round-trip is EXACT: remToSlider rounds to a whole
// step, and sliderToRem(remToSlider(1.35)) comes back 1.352 — the registry would
// disagree with itself by 0.002rem. 1.352 lands exactly on step 52 and round-trips
// cleanly.
//
// globals.css `:root { --chat-font-size }` MUST equal sliderToRem(remToSlider(
// DEFAULT_REM)) — that is the value SettingsHydrator applies when the user has no
// saved size, so any disagreement is a visible font jump on every page load.
const DEFAULT_REM = 1.352;
export function remToSlider(rem: number): number {
  return Math.round(((rem - MIN_REM) / (MAX_REM - MIN_REM)) * 100);
}
export function sliderToRem(val: number): string {
  return (MIN_REM + (val / 100) * (MAX_REM - MIN_REM)).toFixed(3) + "rem";
}

// Font + weight option lists live in ./settingsFonts (large declarative tables);
// re-exported here so FONTS/WEIGHTS keep resolving from settingsRegistry.
export { FONTS, WEIGHTS } from "./settingsFonts";
import { remapFont } from "./settingsFonts";

// The chat content shadow is a two-layer drop (a tight near-opaque layer + a
// softer spread) emitted in two forms from ONE spec: `--chat-shadow`
// (text-shadow, inherited by the username/timestamp/score/text) and
// `--chat-shadow-filter` (a drop-shadow filter for the non-text bits — platform
// indicator, badges, avatar). The `shadowStrength` (opacity ×) and `shadowBlur`
// (radius ×) sliders scale the base; offsets do NOT follow blur, so the "drop"
// stays tight as blur softens. The offsets follow their own two sliders instead:
// `shadowAngle` TURNS every offset around the glyph and `shadowDistance`
// multiplies its length — see shadowOffset() below. The pre-paint mirror in
// layout.tsx must recompute this with the same formula.
//
// THE THREE FORMS ARE NOT INTERCHANGEABLE. `filter: drop-shadow(A)
// drop-shadow(B)` CHAINS — B shadows the glyph *plus A's shadow*, so the second
// layer doubles up, while `text-shadow: A, B` composites both from the original
// alpha. Same numbers therefore buy matching INTENT, not matching weight.
//
// How much that costs: ink summed over a single glyph's whole field ("1.77×
// the ink") is dominated by the far tail, where the difference is 1-2 of 255
// across thousands of pixels — it overstates what an eye sees. Scored per pixel
// against the intended unchained composite, at real chat sizes on all three
// real shapes (glyph, 18px badge, 26px avatar): the chained form is **+21% to
// +33% ink but only rms 1.7-2.1, max 9 of 255**. Real, and near-invisible.
//
// AND THE OBVIOUS FIX IS A REGRESSION. Collapsing the chain to ONE drop-shadow,
// measured against the same target, scores **rms 2.7-4.4, max 53** — two to
// three times worse than the chaining it would repair, because no single blur
// reproduces both a near-opaque 4px core and a 12px halo. The chain stays. Do
// not re-attempt this without re-running the fit.
const SHADOW_BASE = { r1: 4, r2: 12, a1: 1, a2: 0.85, y1: 1, y2: 2 };

// The BOX form's radii, relative to the other two. Not a tuning knob and not a
// typo: `box-shadow`'s falloff is roughly half as wide as `drop-shadow`'s at
// the same numeric radius. Measured on the live indicator geometry (a 3×42
// solid rect) — at equal numbers the box form reached the background by ~15px
// while the filter form still had ink past 25px, leaving it visibly tighter and
// darker at the core. Swept blur ×1 → ×2 against the shipping chained filter:
// ×2 wins at **rms 1.20, max 6 of 255**, i.e. indistinguishable. Anything that
// changes SHADOW_BASE must re-run that sweep rather than assume this holds.
const SHADOW_BOX_SCALE = 2;
// The HALO — a wide, offset-less layer that only the see-through /chat window
// consumes (globals.css, `.chat-window`): it runs over an arbitrary desktop, so
// it needs separation on every side, not just a drop. It lives HERE because a
// literal in the window's own CSS is one the Shadow toggle and sliders cannot
// reach. `r`/`a` are its text-shadow radius and alpha.
//
// Text form only: picture shadows are one tight layer — see the PICTURES note
// below.
const HALO_BASE = { r: 14, a: 0.8 };

// PICTURES GET ONE TIGHT LAYER, NOT THE CHAIN. The filter form is re-run on
// EVERY FRAME of every animated avatar, badge and emote, and the chain (tight +
// wide + the window's halo) was ~70% of what the Shadow setting cost. Measured
// in Firefox on the /chat window, GPU busy %, name/indicator animations off:
// shadow off 15 · chain 29 · tight-only pictures 21. Compared side by side,
// tight wins. This deliberately trades away the fidelity the
// NOT-INTERCHANGEABLE note above defends — for pictures only; text keeps both
// layers.
//
// HARD style ("duplicate the chat, make it black, shift it a couple pixels
// diagonally" — an OBS trick): every form becomes one solid, UNBLURRED copy
// offset down-right. No blur means no blur pass at all.
const HARD_OFFSET_PX = 2;

// The "no shadow" value for `--chat-shadow-filter`: an EMPTY token stream, not
// the keyword `none`. See applyShadow() below for why.
// NOT the empty string — CSSOM treats `setProperty(name, "")` as REMOVING the
// property, which would fall back to the `:root` default in globals.css and
// leave the shadow on. This is a real, non-empty value that substitutes to
// nothing. Verified in a browser against a :root fallback.
const EMPTY_FILTER = "/**/";

// DIRECTION + DISTANCE. Both act on the offset vector only — radii, alphas and
// the chain are untouched:
//   • `angle` (degrees, −180…180) TURNS each layer's base offset clockwise on
//     screen. It is a turn, not a compass bearing, because the two styles start
//     in different places — soft falls straight down (0,1)/(0,2), hard
//     down-right (2,2) — and 0° must reproduce BOTH byte-for-byte. +90° puts the
//     soft drop on the left, ±180° above, −90° on the right.
//   • `distance` (×, 0…6) multiplies the offset's length; 0 centres the shadow
//     under the glyph (an even glow), 2 doubles the drop.
// Each coordinate is rounded to 0.01px and printed as `0` when it is zero, so
// the defaults (0°, ×1) emit exactly the base strings (`0 1px …`, `2px 2px …`)
// — shadowSpec.test.ts pins that output.
// The halo has no offset and stays centred whatever these say.
// The pre-paint script in layout.tsx carries a character-for-character ES5 copy
// (`_off`); shadowSpec.test.ts RUNS that script and compares.
function offsetPx(v: number): string {
  const n = Math.round(v * 100) / 100;
  return n === 0 ? "0" : `${n}px`;
}
function shadowOffset(x: number, y: number, angle: number, distance: number): string {
  const t = (angle * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return `${offsetPx((x * c - y * s) * distance)} ${offsetPx((x * s + y * c) * distance)}`;
}

// The chat shadow's forms from the four sliders + the hard switch.
// shadowSpec.test.ts lifts this function (and the constants and helpers above)
// out of this file's source and RUNS it — keep them plain top-level functions.
function shadowSpec(strength: number, blur: number, angle: number, distance: number, hard = false) {
  const a1 = Math.min(1, SHADOW_BASE.a1 * strength).toFixed(3);
  if (hard) {
    const o = HARD_OFFSET_PX;
    const solid = `${shadowOffset(o, o, angle, distance)} 0 rgba(0,0,0,${a1})`;
    return {
      text: solid,
      contact: solid,
      filter: `drop-shadow(${solid})`,
      box: solid,
      // Never `none`: the window composes this into a text-shadow LIST
      // (`var(--chat-shadow), var(--chat-shadow-halo)`), where `none` is invalid.
      halo: "0 0 0 transparent",
    };
  }
  const r1 = (SHADOW_BASE.r1 * blur).toFixed(2);
  const r2 = (SHADOW_BASE.r2 * blur).toFixed(2);
  const b1 = (SHADOW_BASE.r1 * blur * SHADOW_BOX_SCALE).toFixed(2);
  const b2 = (SHADOW_BASE.r2 * blur * SHADOW_BOX_SCALE).toFixed(2);
  const a2 = Math.min(1, SHADOW_BASE.a2 * strength).toFixed(3);
  const h = (HALO_BASE.r * blur).toFixed(2);
  const ha = Math.min(1, HALO_BASE.a * strength).toFixed(3);
  const o1 = shadowOffset(0, SHADOW_BASE.y1, angle, distance);
  const o2 = shadowOffset(0, SHADOW_BASE.y2, angle, distance);
  return {
    text:   `${o1} ${r1}px rgba(0,0,0,${a1}), ${o2} ${r2}px rgba(0,0,0,${a2})`,
    // The CONTACT form — the tight layer alone, and its radius does NOT
    // follow the blur slider. It exists for effects that supply their own
    // separation from the background and only need the lift: a glow's halo is a
    // fixed 14px, so a wide layer that grows to 12px × 3 = 36px of near-opaque
    // black is wider than the thing it sits under and swallows it. Alpha still
    // follows strength, because dimming everything together is the one axis that
    // does not make the glow lose.
    contact: `${o1} ${SHADOW_BASE.r1}px rgba(0,0,0,${a1})`,
    // Pictures: the tight layer alone — see the PICTURES note above.
    filter: `drop-shadow(${o1} ${r1}px rgba(0,0,0,${a1}))`,
    // For the indicator's SOLID shapes (bar, dot) — a composited primitive
    // instead of a filter render surface plus two mask blurs, on up to 79
    // elements each. Same alphas, doubled radii; see SHADOW_BOX_SCALE.
    box:    `${o1} ${b1}px rgba(0,0,0,${a1}), ${o2} ${b2}px rgba(0,0,0,${a2})`,
    // The /chat window's halo (text form). See HALO_BASE.
    halo:       `0 0 ${h}px rgba(0,0,0,${ha})`,
  };
}

// The SEPARATOR shade — a different shadow from the one above, and deliberately
// its own control. The chat shadow lifts glyphs off the theme; this one says
// "a layer ends here and the chat surface begins below it", and it is drawn at
// every such boundary: the mobile video seam (`.bb-video-col::after`), the chat
// tab bar, and the Matrix panel header.
//
// It needs TWO forms because neither works in both geometries — the seam's
// source is a 14px sliver, and any negative spread shrinks that to a negative
// height so a box-shadow renders literally nothing; the tab bar is
// `overflow: hidden`, so it clips a ::after of its own. Emitting both from THIS
// one spec is what keeps them matched: a hand-matched pair (measured on a
// mid-grey to within 0.03 alpha) only stays matched until someone edits one of
// them.
//
// `strength` scales opacity, `depth` scales every px dimension together (the
// band's height and the box-shadow's offset/blur/spread), so the shade grows
// and softens as one thing instead of drifting apart. The pre-paint mirror in
// layout.tsx must recompute this with the same formula.
const SEAM_BASE = { h: 14, a1: 0.55, a2: 0.24, y: 6, blur: 13, spread: -3, a: 0.8 };
function seamSpec(strength: number, depth: number) {
  const a = (base: number) => Math.min(1, base * strength).toFixed(3);
  const d = (base: number) => (base * depth).toFixed(2);
  return {
    h: `${d(SEAM_BASE.h)}px`,
    grad: `linear-gradient(to bottom, rgba(0,0,0,${a(SEAM_BASE.a1)}) 0%, rgba(0,0,0,${a(SEAM_BASE.a2)}) 40%, rgba(0,0,0,0) 100%)`,
    box: `0 ${d(SEAM_BASE.y)}px ${d(SEAM_BASE.blur)}px ${d(SEAM_BASE.spread)}px rgba(0,0,0,${a(SEAM_BASE.a)})`,
  };
}

// ─── defaults (the Values shape is derived from this) ─────────────────────────
export const DEFAULTS = {
  sliderVal:    remToSlider(DEFAULT_REM),
  showTs:       false,
  tsFormat:     "standard" as TsFormat,
  fontFamily:   "inherit",
  lineHeight:   1.4,
  fontWeight:   400,
  textColor:    "#e8e6e3",
  tsColor:      "#71717a",
  emoteSize:    1.4,
  emoteOverlap: 2,
  animEmotesOn: true,
  msgGap:       1,
  wrapPadding:  0,
  usernameSat:  1,
  shadowOn:     true,
  shadowStrength: 1,
  shadowBlur:     1,
  // 0° / ×1 = the base offsets.
  shadowAngle:    0,
  shadowDistance: 1,
  shadowHard:     false,
  seamOn:       true,
  seamStrength: 1,
  seamDepth:    1,
  pfpOn:        false,
  pfpRing:      false,
  pronounsOn:   true,
  groupConsecutive: false,
  // Indent continuations: TRUE keeps the indented geometry (the gutter a
  // continuation glyph would sit in), so the default layout has no glyph.
  groupIndent: true,
  altRows: false,
  nameStylesOn:  true,
  badgesOn:      true,
  spotlightOn:   true,
  // Behavior. Never part of a look.
  mentionSound:  "off" as MentionSound,
  mentionHl:     true,
  upvoteHl:      true,
  eventHl:     true,
  ownTint:       false,
  profanityFilter: false,
  unreadDots:    true,
  hideBots:      false,
  firstMark:     true,
  pronounColor:  "coloured" as "coloured" | "plain",
  sendToBtnOn:   true,
  toolsBtnOn:    true,
  pfpRingWidth:  2,
  bgStart:      "#0c1020",
  bgEnd:        "#08080a",
  // Panel colours, model B. bgStart/bgEnd above are the page gradient's two
  // colours; the tint + strengths paint bars and chat body.
  bgDir:          "glow" as BgDir,
  panelTint:      "#141828",
  barStrength:    1,
  bodyStrength:   1,
  usernameFont:   "inherit",
  usernameWeight: 600,
  fallbackNameMode: "colour" as "colour" | "platform",
  fallbackNameColor: "#c3cddb",
  glassColor:         "#0c101c",
  glassOpacity:       0.82,
  glassBlur:          14,
  // The two halves of the old single "glass" idea, now separately switchable.
  // Both default ON here; on phones glassOn defaults OFF — see MOBILE_DEFAULTS.
  glassOn:            true,
  transparencyOn:     true,
  frameColor:         "#ffffff",
  frameOpacity:       0.1,
  frameWidth:         2,
  panelGap:           12,
  roundedCorners:     false,
  emoteBtnOn:         true,
  sendBtnOn:          false,
  sendColor:          "#99c1f1",
  voteColor:          "",
  // Player-bar colours. These MUST match the :root defaults in globals.css —
  // the registry is what a Reset writes back, so a disagreement means "reset"
  // silently changes the look instead of restoring it.
  donateColor:        "#99c1f1",
  giftColor:          "#c98bdd",
  platformIndicator:  "bar" as "bar" | "dot" | "icon" | "none",
  platformPalette: "native" as "native" | "brand",
  piCycle:            true,
  unAnim:             true,
  chatFade:           true,
  piSat:              1,
  piBarW:             3,
  piBarInset:         4,
  piGap:              11,
  // -1 = "Same as indicator gap" (round 2b): the CSS default derives the badge
  // gap from the indicator gap, so the 11 viewers with a custom one keep it.
  badgeGap:           -1,
  showMatrixName:     false,
  dotScale:           1,
  pfpScale:           1,
  badgeScale:         1,
  tsFont:             "inherit",
  tsSize:             1,
  emoteAutoSuggest:   false,
  streamAutoMute:     false,
  histLength:         "default" as HistoryLength,
  winDock:            "float",
  winFrom:            "bottom",
  termButton:         true,
  hideTabBar:         false,
  indentTs:           false,
  // Shell chrome (app frame outside the chat message body)
  shellFont:          "inherit",
  tabSize:            1,
  wordmarkSize:       1,
  titleSize:          1,
  lowPower:     false,
  lowPowerPrev: "",
  // Community settings. The Community timeline's own look and behaviour;
  // everything else it shares with the live chat's keys. Each default is the
  // Community timeline's base look.
  mxLayout:     "cozy" as MxLayout,
  mxAvatars:    true,
  mxTimes:      true,
  mxReactSize:  "normal" as MxReactSize,
  mxDeleted:    "hide" as "hide" | "placeholder",
  mxEditedTag:  true,
  mxUnread:     "dots" as "dots" | "counts",
  mxHideMuted:  false,
  // Privacy (k round 5: both ON by default). Off = no public receipt / no typing
  // event leaves this browser; see app/lib/matrixPrivacy.ts.
  mxReceipts:   true,
  mxTyping:     true,
};

/** Community timeline layout: cozy = default, compact = tighter, bubbles = one tinted block per group. */
export type MxLayout = "cozy" | "compact" | "bubbles";
const MX_LAYOUTS = ["cozy", "compact", "bubbles"] as const;
/** Community reaction pills: normal = default; the multiplier lives in --mx-react-scale. */
export type MxReactSize = "small" | "normal" | "large";
const MX_REACT_SCALE: Record<MxReactSize, string> = { small: "0.85", normal: "1", large: "1.3" };

export type Values = typeof DEFAULTS;
export type SettingKey = keyof Values;

// ─── apply context + low-level DOM helpers ────────────────────────────────────
export interface ApplyCtx {
  get: <K extends SettingKey>(k: K) => Values[K];
  onShowTimestamps?: (v: boolean) => void;
  onShowMatrixName?: (v: boolean) => void;
}

function setProp(k: string, v: string) { document.documentElement.style.setProperty(k, v); }
function rmProp(k: string) { document.documentElement.style.removeProperty(k); }
function cls(c: string, on: boolean) { document.documentElement.classList.toggle(c, on); }

// Glass blur is a custom property, so every glass surface reads ONE value.
// A <style> overriding `.glass` would reach only elements carrying the
// `.glass` class, while components that compose the same look inline
// (`background: var(--glass-bg)` + a blur) would stay frozen at the default:
// dragging the Blur slider would move some surfaces and not others. A custom
// property has no cascade problem to work around and reaches both kinds of
// consumer.

// Recompute the paired/grouped vars from current values (order-independent so
// hydration can run effects in any order).
// Transparency is a MASTER switch over every per-surface opacity slider: with it
// off, each surface's stored opacity is left untouched in localStorage but reads
// as 1 here, so turning the switch back on restores the viewer's exact theme.
// (Zeroing the sliders instead would destroy it.) One helper, so a future
// translucent surface cannot forget to honour the switch.
function alphaOf(ctx: ApplyCtx, o: number): number { return ctx.get("transparencyOn") ? o : 1; }

// The glass fill (pop-ups, menus, pinned banner, compact overlay) keeps a
// solid phone default. Transparency's phone default is ON for the panel
// bars/body only (glass surfaces unchanged); without this an untouched phone's
// pop-ups would go 82% see-through with no blur behind them.
// Only an ABSENT stored value takes this arm — a viewer who switched
// transparency on ("1") gets alphaOf like desktop. Mirrored in layout.tsx.
function glassAlpha(ctx: ApplyCtx): number {
  if (deviceClass() === "mobile" && settingGet("theme_transparencyOn") === null) return 1;
  return alphaOf(ctx, ctx.get("glassOpacity"));
}
function applyGlassBg(ctx: ApplyCtx){ setProp("--glass-bg", hexToRgba(ctx.get("glassColor"), glassAlpha(ctx))); }
// ON removes the override so globals.css's :root --glass-filter applies; OFF
// writes the keyword. Never `blur(0px)` — see the note on --glass-filter.
function applyGlass(ctx: ApplyCtx)  { if (ctx.get("glassOn")) rmProp("--glass-filter"); else setProp("--glass-filter", "none"); }
function applyPanel(ctx: ApplyCtx) {
  const tint = ctx.get("panelTint");
  setProp("--panel-tint-bar",  hexToRgba(tint, alphaOf(ctx, ctx.get("barStrength"))));
  setProp("--panel-tint-body", hexToRgba(tint, alphaOf(ctx, ctx.get("bodyStrength"))));
}
function applyPage(ctx: ApplyCtx) { setProp("--bg-page", pageGradient(ctx.get("bgDir"))); }
// Always the viewer's colour — there is no "Custom border" switch; the defaults
// (#ffffff at 10%) are a subtle border.
function applyFrame(ctx: ApplyCtx)  {
  setProp("--frame-color", hexToRgba(ctx.get("frameColor"), ctx.get("frameOpacity"))); }
// The time column is MEASURED in its own font and size (round 2b; the `ch`
// table resolved in the message font and went stale on every time-font/size
// change). --chat-ts-w makes every row's time one fixed-width column;
// --chat-ts-shown-w is what a grouped row's spacer subtracts, since the time
// still shows there. A web font that loads late re-measures (loadingdone).
// A full settings apply calls this from ~8 effects and each measurement forces
// a whole-page layout, so the work coalesces into ONE per frame (final review);
// the pre-paint's values stand until then.
let lastWrapCtx: ApplyCtx | null = null;
let fontsHooked = false;
let wrapRaf = 0;
function applyWrap(ctx: ApplyCtx) {
  lastWrapCtx = ctx;
  if (!fontsHooked && typeof document !== "undefined" && document.fonts) {
    fontsHooked = true;
    document.fonts.addEventListener("loadingdone", () => { if (lastWrapCtx) applyWrap(lastWrapCtx); });
  }
  if (typeof requestAnimationFrame === "undefined") { applyWrapNow(ctx); return; }
  if (!wrapRaf) wrapRaf = requestAnimationFrame(() => { wrapRaf = 0; if (lastWrapCtx) applyWrapNow(lastWrapCtx); });
}
function applyWrapNow(ctx: ApplyCtx) {
  const fmt = ctx.get("tsFormat");
  const tsOn = ctx.get("showTs");
  const w = tsOn ? measureTsWidth(fmt) : null;
  if (w != null) setProp("--chat-ts-w", w + "px"); else rmProp("--chat-ts-w");
  const col = w != null ? `calc(${w}px + 0.25rem)` : tsIndentWidth(fmt);
  setProp("--chat-ts-shown-w", tsOn ? col : "0px");
  setProp("--chat-wrap-padding", (ctx.get("indentTs") && tsOn) ? col : ctx.get("wrapPadding") + "px");
}
function applyShadow(ctx: ApplyCtx) {
  // OFF is EMPTY_FILTER, not the keyword `none`. The platform indicator
  // composes this var with its saturation in ONE declaration, and
  // `filter: saturate(1.8) none` is INVALID CSS — it drops the whole
  // declaration and takes the saturation with it. An empty token stream
  // substitutes to nothing there, leaving `saturate(1.8)`; where the var
  // stands alone it makes the declaration invalid at computed-value time,
  // which resolves to `filter`'s initial value — `none` — with no compositing
  // layer. Same result as the keyword, and the composition works. All four
  // on/off × alone/composed combinations were verified in a browser;
  // piFilterCompose.test.ts pins it.
  // The BOX form's off value IS the keyword `none` — it is never composed
  // with anything, so it has no invalid-token problem to dodge.
  // `--panel-shadow` (the .bb-panel float) is the odd one out:
  // ON does not write a value, it REMOVES the override so globals.css's `:root`
  // default applies. The panel shadow is a fixed two-layer pair, not a function
  // of shadowStrength/shadowBlur — those two sliders were written for, and are
  // labelled for, the chat row. Restating the pair here would be a second place
  // to change it; removing the property leaves globals.css the only one.
  // Phones are not handled here AT ALL — a media query zeroes them
  // unconditionally, so no setting and no first-paint window can bring it back.
  if (!ctx.get("shadowOn")) {
    setProp("--chat-shadow", "none");
    setProp("--chat-shadow-contact", "none");
    setProp("--chat-shadow-filter", EMPTY_FILTER);
    setProp("--chat-shadow-box", "none");
    // The halo filter is COMPOSED with --chat-shadow-filter in one declaration,
    // so its off value is the empty stream for the same reason.
    setProp("--chat-shadow-halo", "none");
    setProp("--panel-shadow", "none");
    return;
  }
  const spec = shadowSpec(ctx.get("shadowStrength"), ctx.get("shadowBlur"),
    ctx.get("shadowAngle"), ctx.get("shadowDistance"), ctx.get("shadowHard"));
  setProp("--chat-shadow", spec.text);
  setProp("--chat-shadow-contact", spec.contact);
  setProp("--chat-shadow-filter", spec.filter);
  setProp("--chat-shadow-box", spec.box);
  setProp("--chat-shadow-halo", spec.halo);
  rmProp("--panel-shadow"); }
function applySeam(ctx: ApplyCtx) {
  // Off means "no shade at all", not "zero-height": the gradient still has a
  // box on the seam, and `background: none` is what makes it invisible without
  // disturbing the layout the ::after already occupies.
  if (!ctx.get("seamOn")) {
    setProp("--seam-shade", "none");
    setProp("--seam-shade-box", "none");
    return;
  }
  const spec = seamSpec(ctx.get("seamStrength"), ctx.get("seamDepth"));
  setProp("--seam-shade", spec.grad);
  setProp("--seam-shade-box", spec.box);
  setProp("--seam-shade-h", spec.h); }

// ─── control metadata (for rendering the menu) ────────────────────────────────
export type Control =
  | { kind: "font";  label: string }
  | { kind: "color"; label: string; fallbackKey?: SettingKey }
  | { kind: "toggle"; label: string }
  | { kind: "weights"; label: string }
  | { kind: "choice"; label: string; options: readonly { value: string; label: string }[];
      /** Run when the viewer picks an option (the mention sound plays it). */
      preview?: (v: string) => void }
  | { kind: "lowPower"; label: string }
  | { kind: "slider"; label: string; min: number; max: number; step?: number;
      toSlider: (v: number) => number; fromSlider: (n: number) => number;
      display: (v: number) => string; fontSize?: boolean;
      /** Tooltip on the readout — spells out a word readout such as "Auto". */
      title?: string };

// Registry entries are intentionally loosely typed (one shape for all value
// kinds); the public helpers below re-narrow per key, and the effect bodies cast
// at the point of use. `SettingValue` is the value union.
type SettingValue = string | number | boolean;

interface Entry {
  ls: string;
  prePaint: boolean;
  // Device-local: NOT synced to the account (excluded from settingsKeys.ts), so
  // the value can differ per device (e.g. auto-suggest emotes: off on desktop,
  // on for mobile). Same intent as the excluded chatWidth.
  deviceLocal?: boolean;
  // Behavior: how the chat BEHAVES for you, not how it looks — Reset, the
  // preset slots and house looks never read or write it (LOOK_KEYS below). It
  // still syncs per device class.
  behavior?: boolean;
  /** Validate a stored string; null means "absent or invalid, use DEFAULTS". */
  parse: (s: string | null) => SettingValue | null;
  serialize?: (v: SettingValue) => string;
  effect?: (v: SettingValue, ctx: ApplyCtx) => void;
  control: Control;
}

// Parse helpers. These VALIDATE only — they never carry a default value. A
// missing or malformed stored value returns null and parseValue() substitutes
// DEFAULTS[key], so every default is written exactly once, in DEFAULTS — never
// also as an entry field or a parser argument with nothing keeping them in
// agreement.
const str = (s: string | null): SettingValue | null => (s || null);
// Font settings: a removed font maps to its replacement (round 2b).
const parseFont = (s: string | null): SettingValue | null => (s ? remapFont(s) : null);
const flt = (ok: (n: number) => boolean = () => true) =>
  (s: string | null): SettingValue | null => { const n = parseFloat(s ?? ""); return Number.isFinite(n) && ok(n) ? n : null; };
const int = (s: string | null): SettingValue | null => { const n = parseInt(s ?? "", 10); return Number.isNaN(n) ? null : n; };
const bool1 = (s: string | null): SettingValue | null => (s !== null ? s === "1" : null);
const boolStr = (s: string | null): SettingValue | null =>
  (s === "true" ? true : s === "false" ? false : null);
const oneOf = <T extends string>(list: readonly T[]) =>
  (s: string | null): SettingValue | null =>
    (s !== null && (list as readonly string[]).includes(s) ? s : null);
const parseFontSlider = (s: string | null): SettingValue | null => {
  if (!s) return null; const r = parseFloat(s); return isNaN(r) ? null : remToSlider(r);
};
const ser1 = (v: SettingValue) => (v ? "1" : "0");

// slider mapping factories
const sx10 = (label: string, min: number, max: number, unit: string) => ({
  kind: "slider" as const, label, min, max,
  toSlider: (v: number) => Math.round(v * 10), fromSlider: (n: number) => n / 10,
  display: (v: number) => v.toFixed(1) + unit,
});
const sx100 = (label: string, min: number, max: number) => ({
  kind: "slider" as const, label, min, max,
  toSlider: (v: number) => Math.round(v * 100), fromSlider: (n: number) => n / 100,
  display: (v: number) => Math.round(v * 100) + "%",
});
const sraw = (label: string, min: number, max: number, unit: string) => ({
  kind: "slider" as const, label, min, max,
  toSlider: (v: number) => v, fromSlider: (n: number) => n,
  display: (v: number) => v + unit,
});

const E = (e: Entry): Entry => e;

export const ENTRIES: Record<SettingKey, Entry> = {
  // Typography
  sliderVal: E({ ls: "chatFontSize", prePaint: true,
    serialize: (v) => sliderToRem(v as number),
    parse: parseFontSlider,
    // emoteSizingChanged: chat emotes are em-sized off this font, so a bigger font draws
    // more device pixels — every rendered emote re-picks its rung (emoteRes.ts).
    effect: (v, ctx) => { setProp("--chat-font-size", sliderToRem(v as number)); applyWrap(ctx); emoteSizingChanged(); },
    control: { kind: "slider", label: "Text size", min: 0, max: 100,
      toSlider: (v) => v, fromSlider: (n) => n, display: (v) => sliderToRem(v), fontSize: true } }),
  fontFamily: E({ ls: "chatStyle_fontFamily", prePaint: true,
    parse: parseFont, effect: (v, ctx) => { setProp("--chat-font-family", v as string); applyWrap(ctx); },
    control: { kind: "font", label: "Font" } }),
  lineHeight: E({ ls: "chatStyle_lineHeight", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--chat-line-height", String(v)),
    control: sx10("Line height", 10, 24, "") }),
  fontWeight: E({ ls: "chatStyle_fontWeight", prePaint: true,
    parse: int, effect: (v) => setProp("--chat-font-weight", String(v)),
    control: { kind: "weights", label: "Weight" } }),
  textColor: E({ ls: "chatStyle_textColor", prePaint: true,
    parse: str, effect: (v) => setProp("--chat-text-color", v as string),
    control: { kind: "color", label: "Text color" } }),

  // Username
  usernameFont: E({ ls: "chatStyle_usernameFont", prePaint: true,
    parse: parseFont, effect: (v) => setProp("--chat-username-font", v as string),
    control: { kind: "font", label: "Font" } }),
  usernameWeight: E({ ls: "chatStyle_usernameWeight", prePaint: true,
    parse: int, effect: (v) => setProp("--chat-username-weight", String(v)),
    control: { kind: "weights", label: "Weight" } }),
  fallbackNameMode: E({ ls: "chatStyle_fallbackNameMode", prePaint: true,
    parse: oneOf(["colour", "platform"] as const), effect: (v) => cls("chat-fallback-platform", v === "platform"),
    control: { kind: "choice", label: "Names with no colour", options: [
      { value: "colour", label: "One colour" }, { value: "platform", label: "Platform colour" }] } }),
  fallbackNameColor: E({ ls: "chatStyle_fallbackNameColor", prePaint: true,
    parse: str, effect: (v) => setProp("--chat-fallback-name", readableColor(v as string)),
    control: { kind: "color", label: "Fallback name colour" } }),
  usernameSat: E({ ls: "chatStyle_usernameSat", prePaint: true,
    parse: flt(), effect: (v) => setProp("--chat-username-sat", String(v)),
    control: sx10("Saturation", 0, 20, "") }),
  showMatrixName: E({ ls: "chatStyle_showMatrixName", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v, ctx) => ctx.onShowMatrixName?.(v as boolean),
    control: { kind: "toggle", label: "Show Matrix username" } }),

  // Timestamps
  showTs: E({ ls: "showTimestamps", prePaint: false,
    serialize: (v) => String(v), parse: boolStr,
    effect: (v, ctx) => { ctx.onShowTimestamps?.(v as boolean); applyWrap(ctx); },
    control: { kind: "toggle", label: "Show timestamps" } }),
  tsFormat: E({ ls: "chatStyle_tsFormat", prePaint: false,
    parse: oneOf(TS_FORMATS),
    effect: (_v, ctx) => { applyWrap(ctx); window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_tsFormat" })); },
    control: { kind: "choice", label: "Format", options: [
      { value: "standard", label: "Standard" }, { value: "24s", label: "15:04:27" }, { value: "24", label: "15:04" },
      { value: "12", label: "3:04 PM" }, { value: "12s", label: "3:04:27 PM" }, { value: "rel", label: "2m ago" }] } }),
  indentTs: E({ ls: "chatStyle_indentTs", prePaint: true,
    serialize: ser1, parse: bool1, effect: (_v, ctx) => applyWrap(ctx),
    control: { kind: "toggle", label: "Indent to time" } }),
  tsFont: E({ ls: "chatStyle_tsFont", prePaint: true,
    parse: parseFont, effect: (v, ctx) => { setProp("--chat-ts-font", v as string); applyWrap(ctx); },
    control: { kind: "font", label: "Font" } }),
  tsSize: E({ ls: "chatStyle_tsSize", prePaint: true,
    parse: flt((n) => n > 0),
    effect: (v, ctx) => { setProp("--chat-ts-size", chatFontCalc(v as number)); applyWrap(ctx); },
    control: sx10("Size", 5, 15, "×") }),
  tsColor: E({ ls: "chatStyle_tsColor", prePaint: true,
    parse: str, effect: (v) => setProp("--chat-ts-color", v as string),
    control: { kind: "color", label: "Timestamp color" } }),

  // Emotes
  emoteSize: E({ ls: "chatStyle_emoteSize", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => { setProp("--chat-emote-size", v + "em"); emoteSizingChanged(); },
    control: sx10("Emote size", 8, 40, "em") }),
  emoteOverlap: E({ ls: "chatStyle_emoteOverlap", prePaint: true,
    parse: int,
    effect: (v) => setProp("--chat-emote-overlap", v + "px"),
    control: sraw("Spacing", -16, 16, "px") }),
  // Auto-suggest emotes. OFF (default) = plain words don't pop a list on their
  // own: on desktop they wait for Tab; on mobile (no Tab key) they're suppressed
  // entirely (use `:` or the emote picker). ON = plain words auto-open a list
  // everywhere. The `:` colon trigger always auto-opens regardless.
  emoteAutoSuggest: E({ ls: "chatStyle_emoteAutoSuggest", prePaint: false, deviceLocal: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new Event("bb:emote-pref")),
    control: { kind: "toggle", label: "Auto-suggest emotes" } }),
  // Still frames instead of animated emotes. Not
  // prePaint: it changes which URL an <img> requests, not layout/CSS, so there
  // is nothing for the pre-paint script to restore before hydration — same
  // shape as tsFormat just above. Read once at the list level via useSetting
  // (ChatSidebar/ChatWindow/ChatOverlay) and passed down as ChatMessage's
  // `stillEmotes` prop, not subscribed per-row.
  animEmotesOn: E({ ls: "chatStyle_animEmotes", prePaint: false,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_animEmotes" })),
    control: { kind: "toggle", label: "Animated emotes" } }),

  // Player
  // Per-DEVICE (deviceLocal — never account-synced): mute-on-load is a "this
  // computer" preference (desktop speakers vs phone). StreamView reads the ls
  // key via useLocalStorageString and appends each embed's mute param; the
  // untargeted storage-event nudge is what lets that subscriber react to a
  // mid-session toggle (useClientState treats e.key == null as "re-read").
  streamAutoMute: E({ ls: "chatStyle_streamAutoMute", prePaint: false, deviceLocal: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new Event("storage")),
    control: { kind: "toggle", label: "Start stream muted" } }),

  // Performance. Per-DEVICE — a phone's perf choices must never roam onto the
  // desktop via preset sync. Consumed via useLocalStorageString (the
  // untargeted storage nudge is the same-tab refresh, like streamAutoMute
  // above), so prePaint:false is correct: no CSS, no first-paint involvement.
  //
  // Behavior › Chat history length (replaces "Reduced chat history"): the cap
  // NUMBERS only — useChatMessages reads it through historyCaps(), which also
  // reads an old saved "reduced" switch as Short.
  histLength: E({ ls: "chatStyle_histLength", prePaint: false, deviceLocal: true, behavior: true,
    parse: oneOf(["short", "default", "long"] as const),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_histLength" })),
    control: { kind: "choice", label: "Chat history", options: [
      { value: "short", label: "Short" }, { value: "default", label: "Default" }, { value: "long", label: "Long" }] } }),

  // Behavior › Windows: on a computer, tool windows float or slide into the
  // chat column. Per DEVICE — a phone always slides. windowDock.ts reads it
  // with useSetting; a window's own switch is remembered there, and changing
  // this resets those.
  winDock: E({ ls: "chatStyle_winDock", prePaint: false, deviceLocal: true, behavior: true,
    parse: oneOf(["float", "slide"] as const),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_winDock" })),
    control: { kind: "choice", label: "Windows on a computer", options: [
      { value: "float", label: "Float" }, { value: "slide", label: "Slide into chat" }] } }),
  // Behavior › Windows: a sliding window rises from the composer (Bottom, the
  // default) or comes down from the top of the chat, leaving the newest
  // messages clear. Per DEVICE; PanelWindow reads it with useSetting.
  winFrom: E({ ls: "chatStyle_winFrom", prePaint: false, deviceLocal: true, behavior: true,
    parse: oneOf(["bottom", "top"] as const),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_winFrom" })),
    control: { kind: "choice", label: "Windows slide in from", options: [
      { value: "bottom", label: "Bottom" }, { value: "top", label: "Top" }] } }),
  // The terminal's colours and text size are lines in the terminal's own config file — one
  // writer — and a device's older stored choice is carried into the file once by
  // TerminalWindow (keys chatStyle_termTheme / chatStyle_termSize).
  // The `>_` in the chat's top bar, toggled here. Per DEVICE; ChatTabBar reads it with
  // useSetting. Off hides the button only — Ctrl+`, a bare `/` + Enter and a long reply still
  // open the terminal.
  termButton: E({ ls: "chatStyle_termButton", prePaint: false, deviceLocal: true, behavior: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_termButton" })),
    control: { kind: "toggle", label: "Terminal button" } }),

  // Spacing
  msgGap: E({ ls: "chatStyle_msgGap", prePaint: true,
    parse: flt(), effect: (v) => setProp("--chat-msg-gap", v + "px"),
    control: sraw("Message gap", 0, 12, "px") }),
  wrapPadding: E({ ls: "chatStyle_wrapPadding", prePaint: true,
    parse: flt(), effect: (_v, ctx) => applyWrap(ctx),
    control: sraw("Wrap indent", 0, 60, "px") }),

  // Visual
  shadowOn: E({ ls: "chatStyle_shadow", prePaint: true,
    serialize: ser1, parse: bool1,
    effect: (_v, ctx) => applyShadow(ctx),
    control: { kind: "toggle", label: "Shadow" } }),
  shadowStrength: E({ ls: "chatStyle_shadowStrength", prePaint: true,
    parse: flt((n) => n > 0), effect: (_v, ctx) => applyShadow(ctx),
    control: sx100("Shadow strength", 20, 150) }),
  shadowBlur: E({ ls: "chatStyle_shadowBlur", prePaint: true,
    parse: flt((n) => n > 0), effect: (_v, ctx) => applyShadow(ctx),
    control: sx10("Shadow blur", 2, 30, "×") }),
  // See shadowOffset(). Both apply to the soft AND hard styles.
  shadowAngle: E({ ls: "chatStyle_shadowAngle", prePaint: true,
    parse: flt((n) => n >= -180 && n <= 180), effect: (_v, ctx) => applyShadow(ctx),
    control: { ...sraw("Shadow direction", -180, 180, "°"), step: 5,
      title: "Turns the shadow around the text — 0° is where it normally falls; more turns it clockwise" } }),
  shadowDistance: E({ ls: "chatStyle_shadowDistance", prePaint: true,
    parse: flt((n) => n >= 0 && n <= 6), effect: (_v, ctx) => applyShadow(ctx),
    control: sx10("Shadow distance", 0, 60, "×") }),
  // ON = the hard shadow: one solid unblurred copy offset down-right (see
  // HARD_OFFSET_PX). Strength still sets its darkness; blur has nothing to do.
  shadowHard: E({ ls: "chatStyle_shadowHard", prePaint: true,
    serialize: ser1, parse: bool1,
    effect: (_v, ctx) => applyShadow(ctx),
    control: { kind: "toggle", label: "Hard shadow" } }),
  seamOn: E({ ls: "chatStyle_seam", prePaint: true,
    serialize: ser1, parse: bool1,
    effect: (_v, ctx) => applySeam(ctx),
    control: { kind: "toggle", label: "Separator shadow" } }),
  seamStrength: E({ ls: "chatStyle_seamStrength", prePaint: true,
    parse: flt((n) => n > 0), effect: (_v, ctx) => applySeam(ctx),
    control: sx100("Separator strength", 20, 150) }),
  seamDepth: E({ ls: "chatStyle_seamDepth", prePaint: true,
    parse: flt((n) => n > 0), effect: (_v, ctx) => applySeam(ctx),
    control: sx10("Separator depth", 2, 30, "×") }),
  pfpOn: E({ ls: "chatStyle_pfp", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-pfp-on", v as boolean),
    control: { kind: "toggle", label: "Avatars in chat" } }),
  pfpRing: E({ ls: "chatStyle_pfpRing", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-pfp-ring-on", v as boolean),
    control: { kind: "toggle", label: "Platform ring" } }),
  // ♂ ♀ ⚲ before names (shown by default). The OBS source and the /chat window
  // keep their own copy through the "ov:" scope.
  pronounsOn: E({ ls: "chatStyle_pronouns", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-pron-off", !(v as boolean)),
    control: { kind: "toggle", label: "Pronoun symbols" } }),
  groupConsecutive: E({ ls: "chatStyle_groupConsecutive", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-group-on", v as boolean),
    control: { kind: "toggle", label: "Group consecutive" } }),
  // Alignment of the continuation lines inside a grouped run. Only meaningful
  // while `groupConsecutive` is on, which is why settingsMenu gates it on that.
  // The CLASS IS INVERTED against the value: the default (indent) is the bare
  // CSS, and `chat-group-flush` is added only when the user turns indenting OFF.
  // Deliberate — it keeps the common case free of a prepaint class write, and
  // an absent localStorage key then means "default" in the CSS as well as here.
  // prePaint because it is layout: applied late, continuations jump on reload.
  groupIndent: E({ ls: "chatStyle_groupIndent", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-group-flush", !(v as boolean)),
    control: { kind: "toggle", label: "Indent continuations" } }),
  altRows: E({ ls: "chatStyle_altRows", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("alt-rows", v as boolean),
    control: { kind: "toggle", label: "Alternating rows" } }),
  // Name styles on/off: OFF shows every name — own included — in its plain
  // colour. CSS-only (globals.css .chat-namestyles-off) so the site, /chat and
  // the OBS source all follow it with no row re-render.
  nameStylesOn: E({ ls: "chatStyle_nameStyles", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-namestyles-off", !(v as boolean)),
    control: { kind: "toggle", label: "Name styles" } }),
  badgesOn: E({ ls: "chatStyle_badges", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-badges-off", !(v as boolean)),
    control: { kind: "toggle", label: "Badges" } }),
  // The streamer's click-to-spotlight card, for THIS viewer. Paid /highlight
  // cards are never affected — someone paid for that. CSS-only, like Badges,
  // so no row re-renders.
  spotlightOn: E({ ls: "chatStyle_spotlight", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-spotlight-off", !(v as boolean)),
    control: { kind: "toggle", label: "Streamer spotlight" } }),
  // Behavior.
  mentionSound: E({ ls: "chatStyle_mentionSound", prePaint: false, behavior: true,
    parse: oneOf(MENTION_SOUNDS),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mentionSound" })),
    control: { kind: "choice", label: "When I'm mentioned", preview: playMentionSound, options: [
      { value: "off", label: "Off" }, { value: "ping", label: "Ping" }, { value: "chime", label: "Chime" },
      { value: "pop", label: "Pop" }, { value: "knock", label: "Knock" }] } }),
  // Row tints are CSS classes (globals.css), so these switch without re-rendering.
  mentionHl: E({ ls: "chatStyle_mentionHl", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-mention-hl-off", !(v as boolean)),
    control: { kind: "toggle", label: "Mentions of me" } }),
  upvoteHl: E({ ls: "chatStyle_upvoteHl", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-upvote-hl-off", !(v as boolean)),
    control: { kind: "toggle", label: "Upvoted messages" } }),
  // Support event highlights: off clears the tint behind tip / sub / gift
  // cards; their text and icon stay. The tint is inline (its colour is
  // per-platform), so the class works through a var the row's colour falls
  // back from — see ChatMessage's eventBgColor.
  eventHl: E({ ls: "chatStyle_eventHl", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-event-hl-off", !(v as boolean)),
    control: { kind: "toggle", label: "Support events" } }),
  ownTint: E({ ls: "chatStyle_ownTint", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-own-tint", v as boolean),
    control: { kind: "toggle", label: "Tint my messages" } }),
  // Masks text as rows render; the chat lists read it with useSetting and pass it down.
  profanityFilter: E({ ls: "chatStyle_profanityFilter", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_profanityFilter" })),
    control: { kind: "toggle", label: "Hide swear words" } }),
  // The bot flag comes from the SERVER's bot list; the lists read it with
  // useSetting. The first-time tag is CSS-only, like Badges.
  hideBots: E({ ls: "chatStyle_hideBots", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_hideBots" })),
    control: { kind: "toggle", label: "Hide bots" } }),
  firstMark: E({ ls: "chatStyle_firstMark", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-first-off", !(v as boolean)),
    control: { kind: "toggle", label: "Mark first-time chatters" } }),
  unreadDots: E({ ls: "chatStyle_unreadDots", prePaint: true, behavior: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-dots-off", !(v as boolean)),
    control: { kind: "toggle", label: "Unread dots" } }),
  pronounColor: E({ ls: "chatStyle_pronounColor", prePaint: true,
    parse: oneOf(["coloured", "plain"] as const), effect: (v) => cls("chat-pron-plain", v === "plain"),
    control: { kind: "choice", label: "Pronoun colour", options: [
      { value: "coloured", label: "Coloured" }, { value: "plain", label: "Plain" }] } }),
  sendToBtnOn: E({ ls: "chatStyle_sendToBtn", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-sendto-btn-off", !(v as boolean)),
    control: { kind: "toggle", label: "Send-to button" } }),
  toolsBtnOn: E({ ls: "chatStyle_toolsBtn", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-tools-btn-off", !(v as boolean)),
    control: { kind: "toggle", label: "\"+\" tools button" } }),
  pfpRingWidth: E({ ls: "chatStyle_pfpRingWidth", prePaint: true,
    parse: flt((n) => n >= 1 && n <= 5), effect: (v) => setProp("--chat-pfp-ring-w", `${v}px`),
    control: sraw("Ring thickness", 1, 5, "px") }),
  emoteBtnOn: E({ ls: "chatStyle_emoteBtn", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-emote-btn-on", v as boolean),
    control: { kind: "toggle", label: "Emote button" } }),
  sendBtnOn: E({ ls: "chatStyle_sendBtn", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-send-btn-on", v as boolean),
    control: { kind: "toggle", label: "Send button" } }),
  platformIndicator: E({ ls: "chatStyle_platformIndicator", prePaint: true,
    parse: oneOf(["bar", "dot", "icon", "none"] as const),
    effect: (v) => { cls("chat-pi-dot", false); cls("chat-pi-icon", false); cls("chat-pi-none", false);
      if (v !== "bar") cls(`chat-pi-${v}`, true); },
    control: { kind: "choice", label: "Platform style", options: [
      { value: "bar", label: "Bar" }, { value: "dot", label: "Dot" },
      { value: "icon", label: "Icon" }, { value: "none", label: "None" },
    ] } }),
  platformPalette: E({ ls: "chatStyle_platformPalette", prePaint: true,
    parse: oneOf(["native", "brand"] as const),
    effect: (v) => { for (const [p, hex] of Object.entries(BRAND_PLATFORM_COLORS)) {
      if (v === "brand") setProp(`--pc-${p}`, hex); else rmProp(`--pc-${p}`); } },
    control: { kind: "choice", label: "Platform colours", options: [
      { value: "native", label: siteName() }, { value: "brand", label: "Default" }] } }),
  // Multi-platform "Send to: all" indicator color cycle. prePaint:false — it
  // only gates a CSS animation (no layout/paint flash), so no layout.tsx
  // prepaint-mirror line is needed. The class marks the OFF state.
  piCycle: E({ ls: "chatStyle_piCycle", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-pi-nocycle", !(v as boolean)),
    control: { kind: "toggle", label: "Animate multi-platform" } }),
  // Token-store username styles (rainbow/pulse/shimmer/wobble). Same shape as
  // piCycle: prePaint:false (gates only a CSS animation), class marks OFF.
  unAnim: E({ ls: "chatStyle_unAnim", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v) => cls("un-noanim", !(v as boolean)),
    control: { kind: "toggle", label: "Animate name styles" } }),
  // Top-of-chat fade. Same shape as piCycle: prePaint:false (gates a mask, no
  // layout), class marks OFF. CSS: globals.css "Chat top fade".
  chatFade: E({ ls: "chatStyle_chatFade", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-fade-off", !(v as boolean)),
    control: { kind: "toggle", label: "Fade chat at the top" } }),
  piSat: E({ ls: "chatStyle_piSat", prePaint: true,
    parse: flt(), effect: (v) => setProp("--chat-pi-sat", String(v)),
    control: sx10("Indic. sat", 0, 20, "×") }),
  piBarW: E({ ls: "chatStyle_piBarW", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--chat-pi-bar-w", v + "px"),
    control: sraw("Bar width", 1, 10, "px") }),
  piBarInset: E({ ls: "chatStyle_piBarInset", prePaint: true,
    parse: flt(), effect: (v) => setProp("--chat-pi-bar-inset", v + "px"),
    control: sraw("Bar inset", 0, 12, "px") }),
  // Gap between the platform indicator (dot/icon/avatar) or a badge block and the
  // username — one var drives all four inline spots in ChatMessage so they move
  // together. Default a touch wider than the old hardcoded 9px.
  piGap: E({ ls: "chatStyle_piGap", prePaint: true,
    parse: flt((n) => n >= 0), effect: (v) => setProp("--chat-pi-gap", v + "px"),
    control: sraw("Indicator gap", 0, 20, "px") }),
  // Between badges and before the name (k round 2b: "need both gaps
  // controllable"). -1 hands it back to the CSS default, the indicator gap.
  badgeGap: E({ ls: "chatStyle_badgeGap", prePaint: true,
    parse: flt((n) => n >= -1),
    effect: (v) => { if ((v as number) < 0) rmProp("--chat-badge-gap"); else setProp("--chat-badge-gap", v + "px"); },
    control: { kind: "slider" as const, label: "Badge gap", min: -1, max: 20,
      toSlider: (v: number) => v, fromSlider: (n: number) => n,
      display: (v: number) => (v < 0 ? "Auto" : v + "px"),
      title: "Auto = same as the indicator gap" } }),
  dotScale: E({ ls: "chatStyle_dotScale", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--chat-dot-scale", String(v)),
    control: sx10("Dot size", 5, 30, "×") }),
  pfpScale: E({ ls: "chatStyle_pfpScale", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--chat-pfp-scale", String(v)),
    control: sx10("Avatar size", 5, 30, "×") }),
  badgeScale: E({ ls: "chatStyle_badgeScale", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--chat-badge-scale", String(v)),
    control: sx10("Badge size", 5, 30, "×") }),

  // Tabs
  hideTabBar: E({ ls: "chatStyle_hideTabBar", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("chat-tabbar-hidden", v as boolean),
    control: { kind: "toggle", label: "Fold tab bar" } }),
  sendColor: E({ ls: "chatStyle_sendColor", prePaint: true,
    parse: str, effect: (v) => setProp("--chat-send-color", v as string),
    control: { kind: "color", label: "Send button" } }),
  // Split from sendColor. Empty = follow the send colour, so accounts with a
  // custom send colour keep matching arrows with no conversion.
  voteColor: E({ ls: "chatStyle_voteColor", prePaint: true,
    parse: str,
    effect: (v) => ((v as string) ? setProp("--chat-vote-color", v as string) : rmProp("--chat-vote-color")),
    control: { kind: "color", label: "Vote arrows", fallbackKey: "sendColor" } }),

  // Player-bar colours — the viewer's, not the platform's: themes are up to the
  // viewer. A platform brand as the in-house default accent is never a
  // decision, and a colour that changes when you subscribe makes the button's
  // own state ambiguous.
  // The LABEL still tracks subscription (Gift vs Subscribe) — only the hue is
  // the viewer's. prePaint → both need a mirror in layout.tsx.
  // Each colour also writes its INK (readable label) as a sibling var. CSS has
  // no dependable contrast function, so the choice has to be made in JS — and it
  // is made in BOTH places that can set the colour: here, and the layout.tsx
  // prepaint mirror. Set the colour without the ink and a dark pick renders an
  // unreadable button; set it only here and it flashes unreadable until hydration.
  donateColor: E({ ls: "theme_donateColor", prePaint: true,
    parse: str,
    effect: (v) => { setProp("--donate-color", v as string); setProp("--donate-ink", inkOn(v as string)); },
    control: { kind: "color", label: "Donate button" } }),
  giftColor: E({ ls: "theme_giftColor", prePaint: true,
    parse: str,
    effect: (v) => { setProp("--gift-color", v as string); setProp("--gift-ink", inkOn(v as string)); },
    control: { kind: "color", label: "Gift button" } }),

  // Overlays (.glass)
  glassColor: E({ ls: "theme_glassColor", prePaint: true,
    parse: str, effect: (_v, ctx) => applyGlassBg(ctx),
    control: { kind: "color", label: "Tint color" } }),
  glassOpacity: E({ ls: "theme_glassOpacity", prePaint: true,
    parse: flt(), effect: (_v, ctx) => applyGlassBg(ctx),
    control: sx100("Opacity", 0, 100) }),
  // The two switches below are the ONLY way to remove these costs. The Blur
  // slider cannot: `blur(0px)` is still a backdrop-filter. The Opacity sliders
  // cannot: at 100% `.glass` still runs its blur over a fully occluded
  // backdrop — glass logic for no reason.
  glassOn: E({ ls: "theme_glassOn", prePaint: true,
    serialize: ser1, parse: bool1, effect: (_v, ctx) => applyGlass(ctx),
    control: { kind: "toggle", label: "Glass blur" } }),
  transparencyOn: E({ ls: "theme_transparencyOn", prePaint: true,
    serialize: ser1, parse: bool1,
    // Every translucent surface at once — the switch is the point.
    effect: (_v, ctx) => { applyGlassBg(ctx); applyPanel(ctx); },
    control: { kind: "toggle", label: "Transparency" } }),
  glassBlur: E({ ls: "theme_glassBlur", prePaint: true,
    parse: flt(), effect: (v) => setProp("--glass-blur", `${v as number}px`),
    control: sraw("Blur", 0, 40, "px") }),

  // Background
  bgStart: E({ ls: "theme_bgStart", prePaint: true,
    parse: str, effect: (v) => setProp("--bg-body-start", v as string),
    control: { kind: "color", label: "Background 1" } }),
  bgEnd: E({ ls: "theme_bgEnd", prePaint: true,
    parse: str, effect: (v) => setProp("--bg-body-end", v as string),
    control: { kind: "color", label: "Background 2" } }),
  bgDir: E({ ls: "theme_bgDir", prePaint: true,
    parse: oneOf(BG_DIRS), effect: (_v, ctx) => applyPage(ctx),
    control: { kind: "choice", label: "Direction", options: [
      { value: "glow", label: "Glow" }, { value: "down", label: "↓" }, { value: "right", label: "→" },
      { value: "diag-down", label: "↘" }, { value: "diag-up", label: "↗" },
    ] } }),
  panelTint: E({ ls: "theme_panelTint", prePaint: true,
    parse: str, effect: (_v, ctx) => applyPanel(ctx),
    control: { kind: "color", label: "Tint" } }),
  barStrength: E({ ls: "theme_barStrength", prePaint: true,
    parse: flt((n) => n >= 0 && n <= 1), effect: (_v, ctx) => applyPanel(ctx),
    control: sx100("Bar strength", 0, 100) }),
  bodyStrength: E({ ls: "theme_bodyStrength", prePaint: true,
    parse: flt((n) => n >= 0 && n <= 1), effect: (_v, ctx) => applyPanel(ctx),
    control: sx100("Body strength", 0, 100) }),

  // Frame
  frameColor: E({ ls: "theme_frameColor", prePaint: true,
    parse: str, effect: (_v, ctx) => applyFrame(ctx),
    control: { kind: "color", label: "Border colour" } }),
  frameOpacity: E({ ls: "theme_frameOpacity", prePaint: true,
    parse: flt(), effect: (_v, ctx) => applyFrame(ctx),
    control: sx100("Opacity", 0, 100) }),
  frameWidth: E({ ls: "theme_frameWidth", prePaint: true,
    parse: flt((n) => n >= 0), effect: (v) => setProp("--frame-width", `${v}px`),
    control: sraw("Thickness", 0, 8, "px") }),

  // Layout
  panelGap: E({ ls: "theme_panelGap", prePaint: true,
    parse: flt((n) => n >= 0), effect: (v) => setProp("--panel-gap", `${v}px`),
    control: sraw("Panel gap", 0, 32, "px") }),
  // Rounded corners — OFF by default (square). On => remove `panels-square` so
  // the .bb-panel per-corner radii (outer corners only) take effect.
  roundedCorners: E({ ls: "theme_roundedCorners", prePaint: true,
    serialize: ser1, parse: bool1, effect: (v) => cls("panels-square", !(v as boolean)),
    control: { kind: "toggle", label: "Rounded corners" } }),

  // Shell chrome typography — the app frame OUTSIDE the chat message body: the
  // Live/Matrix tabs, the site-name wordmark, the video title and the action
  // buttons. One shared font + per-element size multipliers (× of each element's
  // base px). The top bars are --chrome-top-h = --tab-size + 22px, so a larger
  // tab size grows them and the attached-video sizing (a CSS sum of the tokens)
  // re-fits by itself; the wordmark / title / button sizes scale their text
  // inside the token, not the bar. Base px: tabs/wordmark/title 0.875rem, btn 0.75rem.
  shellFont: E({ ls: "shell_font", prePaint: true,
    parse: parseFont, effect: (v) => setProp("--shell-font", v as string),
    control: { kind: "font", label: "Font" } }),
  tabSize: E({ ls: "shell_tabSize", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--tab-size", `calc(0.875rem * ${v})`),
    control: sx10("Tab size", 5, 20, "×") }),
  wordmarkSize: E({ ls: "shell_wordmarkSize", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--wordmark-size", `calc(0.875rem * ${v})`),
    control: sx10("Wordmark size", 5, 24, "×") }),
  titleSize: E({ ls: "shell_titleSize", prePaint: true,
    parse: flt((n) => n > 0), effect: (v) => setProp("--title-size", `calc(0.875rem * ${v})`),
    control: sx10("Title size", 5, 20, "×") }),

  // Low power: the switch's logic lives in lowPower.ts; ChatSettings renders it
  // (control kind "lowPower"). lowPowerPrev is its memory — a comma list of
  // registry keys — and has no menu row of its own.
  lowPower: E({ ls: "chatStyle_lowPower", prePaint: false,
    serialize: ser1, parse: bool1,
    control: { kind: "lowPower", label: "Low power" } }),
  // `str` is fine here even though it folds "" to null: lowPowerPrev's own
  // DEFAULT is "" too, so a stored empty string and a missing/invalid one
  // parse to the identical value (settingsDefaults.test.ts bans an inline
  // arrow as a parser — every validator must be a named helper).
  lowPowerPrev: E({ ls: "chatStyle_lowPowerPrev", prePaint: false,
    parse: str,
    control: { kind: "lowPower", label: "Low power memory" } }),

  // Community. Not prePaint: the Community timeline renders only once the
  // Matrix client has started, seconds after first paint, by which time
  // SettingsHydrator has run every effect. The look four are classes / a var on
  // <html> (no row re-renders), like Badges.
  mxLayout: E({ ls: "chatStyle_mxLayout", prePaint: false,
    parse: oneOf(MX_LAYOUTS),
    effect: (v) => { cls("mx-compact", v === "compact"); cls("mx-bubbles", v === "bubbles");
      window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mxLayout" })); },
    control: { kind: "choice", label: "Layout", options: [
      { value: "cozy", label: "Cozy" }, { value: "compact", label: "Compact" }, { value: "bubbles", label: "Bubbles" }] } }),
  mxAvatars: E({ ls: "chatStyle_mxAvatars", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v) => cls("mx-avatars-off", !(v as boolean)),
    control: { kind: "toggle", label: "Avatars" } }),
  mxTimes: E({ ls: "chatStyle_mxTimes", prePaint: false,
    serialize: ser1, parse: bool1, effect: (v) => cls("mx-times-off", !(v as boolean)),
    control: { kind: "toggle", label: "Times" } }),
  mxReactSize: E({ ls: "chatStyle_mxReactSize", prePaint: false,
    parse: oneOf(["small", "normal", "large"] as const),
    effect: (v) => setProp("--mx-react-scale", MX_REACT_SCALE[v as MxReactSize]),
    control: { kind: "choice", label: "Reaction size", options: [
      { value: "small", label: "Small" }, { value: "normal", label: "Normal" }, { value: "large", label: "Large" }] } }),
  // What shows — Behavior, so Reset and saved looks leave them alone. Read at the
  // list level with useSetting (Timeline / ChannelColumn).
  mxDeleted: E({ ls: "chatStyle_mxDeleted", prePaint: false, behavior: true,
    parse: oneOf(["hide", "placeholder"] as const),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mxDeleted" })),
    control: { kind: "choice", label: "Deleted messages", options: [
      { value: "hide", label: "Hide" }, { value: "placeholder", label: "Show a note" }] } }),
  mxEditedTag: E({ ls: "chatStyle_mxEditedTag", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mxEditedTag" })),
    control: { kind: "toggle", label: "\"(edited)\" tag" } }),
  mxUnread: E({ ls: "chatStyle_mxUnread", prePaint: false, behavior: true,
    parse: oneOf(["dots", "counts"] as const),
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mxUnread" })),
    control: { kind: "choice", label: "Unread channels", options: [
      { value: "dots", label: "Dots" }, { value: "counts", label: "Counts" }] } }),
  mxHideMuted: E({ ls: "chatStyle_mxHideMuted", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    effect: () => window.dispatchEvent(new CustomEvent("bb:setting", { detail: "chatStyle_mxHideMuted" })),
    control: { kind: "toggle", label: "Hide muted channels" } }),
  // Privacy: read at SEND time by app/lib/matrixPrivacy.ts (no effect needed).
  mxReceipts: E({ ls: "chatStyle_mxReceipts", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    control: { kind: "toggle", label: "Send read receipts" } }),
  mxTyping: E({ ls: "chatStyle_mxTyping", prePaint: false, behavior: true,
    serialize: ser1, parse: bool1,
    control: { kind: "toggle", label: "Send typing" } }),
};

export const SETTING_KEYS = Object.keys(ENTRIES) as SettingKey[];
/** Every setting that is part of a LOOK — what Reset restores and a preset slot or
 *  house look carries. Behavior settings are left out. */
export const LOOK_KEYS = SETTING_KEYS.filter((k) => !ENTRIES[k].behavior);
/** Behavior settings that /chat and the OBS page never offer (the device-local
 *  one, Chat history length, has its own window control). On those pages they are
 *  read from the SITE's key, never an "ov:" copy — see settingGet. The pre-paint
 *  shim in layout.tsx carries the same list (behaviorSection.test.ts pins it). */
export const SITE_SCOPED_LS = new Set(SETTING_KEYS.filter((k) => ENTRIES[k].behavior && !ENTRIES[k].deviceLocal).map((k) => ENTRIES[k].ls));

// ─── runtime: parse / serialize / apply ───────────────────────────────────────
export function serializeValue<K extends SettingKey>(key: K, v: Values[K]): string {
  const e = ENTRIES[key];
  return e.serialize ? e.serialize(v) : String(v);
}
// ─── device-dependent defaults ────────────────────────────────────────────────
// On a phone, shadows are off by default. A phone re-rasterises the whole chat
// list on every keyboard frame, and the shadow is drawn per glyph and per
// indicator across the entire buffer; a desktop never pays that. So "unset"
// means something different on the two.
//
// KEEP THIS MAP TINY. A device-dependent default is a SECOND truth about
// what an absent key means, and it has to be mirrored by hand in the pre-paint
// script in layout.tsx — check-prepaint proves the key is *read* there, not
// that the two agree on the default. `shadowDefaults.test.ts` pins the pair.
// It applies only to an ABSENT/invalid value: once the viewer touches the
// toggle, the stored value wins on every device.
// Transparency is ON on phones (model B only flows when bars are
// see-through); the heat cost is the blur, which glassOn keeps off.
// DEFAULT, not override — unlike the panel float, which is unreachable on
// phones and is therefore a plain media query in globals.css rather than an
// entry here.
const MOBILE_DEFAULTS: Partial<Values> = { shadowOn: false, glassOn: false };

/** The default for `key` on THIS device — DEFAULTS unless the map overrides. */
export function defaultFor<K extends SettingKey>(key: K): Values[K] {
  const m = MOBILE_DEFAULTS as Record<string, unknown>;
  return (deviceClass() === "mobile" && key in m ? m[key] : DEFAULTS[key]) as Values[K];
}

// Not exported: setValue() below is the only caller, and both of parseValue's
// former external callers now go through it. A symbol only its own file reads
// should not be exported for check-orphans to argue about.
function parseValue<K extends SettingKey>(key: K, s: string | null): Values[K] {
  const v = ENTRIES[key].parse(s);
  return (v === null ? defaultFor(key) : v) as Values[K];
}
export function applyEffect<K extends SettingKey>(key: K, v: Values[K], ctx: ApplyCtx): void {
  ENTRIES[key].effect?.(v, ctx);
}

// Write one parsed setting into a Values object.
//
// Both callers (readValues below, ChatSettings' applyBlob) walk SETTING_KEYS,
// where `key` is the union SettingKey rather than one member of it, so
// `out[key] = parseValue(key, raw)` is a write of `Values[SettingKey]` into a
// slot typed `Values[thatOneKey]` — which TypeScript rejects, correctly. Both
// sites used to buy their way out with `(out as any)[key] = …`, an assertion
// that would have swallowed a genuinely wrong value type just as happily.
// Binding K per call is what makes the write sound, so the cast disappears
// instead of being explained.
export function setValue<K extends SettingKey>(target: Values, key: K, raw: string | null): void {
  target[key] = parseValue(key, raw);
}

// Build a full Values object from localStorage (DB→localStorage already merged by
// the caller). Falls back to defaults per key.
export function readValues(): Values {
  const out = { ...DEFAULTS } as Values;
  for (const key of SETTING_KEYS) {
    const raw = settingGet(ENTRIES[key].ls);
    setValue(out, key, raw);
  }
  return out;
}

// ─── menu layout ──────────────────────────────────────────────────────────────
// Which settings appear, in which tabs, and in what order is presentation data,
// not the behavior core above, so it lives in ./settingsMenu — which imports
// SettingKey/Values from here as type-only.
//
// Deliberately NOT re-exported. `export * from "./settingsMenu"` would close a
// module cycle (registry → menu → registry) that check-structure flags; it is
// erased at build, but the two halves could no longer be reasoned about
// separately. Import SECTIONS/TABS/MenuItem/MenuSection/MenuTab straight from
// ./settingsMenu — the direction of the dependency is then one-way and obvious.
