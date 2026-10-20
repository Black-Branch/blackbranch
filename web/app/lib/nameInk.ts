// The side room a styled name actually needs.
//
// usernameStyleCSS pads a spilling face by its WORST CASE over the alphabet, so
// the swashes always have somewhere to go. But the worst case belongs to a
// curly T or j that most names don't have: at chat size `elegant` would put 24px after
// the badge and 13px before the colon, where a plain name has 12 and 1–2. This
// measures the name that is really there, once its face has loaded, and hands
// the result to the padding (and the duo ramp's insets) through --un-ink-l /
// --un-ink-r. Until then the worst case stands — too much room, never too little.
//
// The WHOLE name, never its first and last letter: a later letter's swash can
// reach back past the first one (a first/last-letter version puts Elegant's
// "WAVEgg" on the badge and Handwritten's on the colon).
//
// Cost: one canvas measureText per distinct (face, name), cached for the page's
// life; nothing per render once cached, and nothing at all for a plain name.
import { useCallback, useEffect, useRef } from "react";
import { nameFontFamily } from "./usernameStyles.ts";

type InkMetrics = Pick<TextMetrics, "actualBoundingBoxLeft" | "actualBoundingBoxRight" | "width">;

/** How far `m`'s ink leaves its advance box on each side, in em (never < 0).
 *  @test-only exported so nameInk.test.ts can pin the arithmetic without a canvas; production calls it in-file. */
export function inkFromMetrics(m: InkMetrics, size: number): { left: number; right: number } {
  const r = (v: number) => Math.round(Math.max(0, v / size) * 100) / 100;
  return { left: r(m.actualBoundingBoxLeft), right: r(m.actualBoundingBoxRight - m.width) };
}

/** The custom property a stack names first ("var(--font-x), cursive" → "--font-x").
 *  @test-only exported so nameInk.test.ts can pin the parse; production calls it in-file (familyOf). */
export function firstFamilyVar(stack: string): string | null {
  return /^\s*var\((--[\w-]+)\)/.exec(stack)?.[1] ?? null;
}

// 100px: TextMetrics are whole device pixels, so a small size quantises badly.
// Weight 600 — what every surface renders names at.
const SIZE = 100;
const cache = new Map<string, { left: number; right: number }>();
const families = new Map<string, string | null>();
let ctx: CanvasRenderingContext2D | null | undefined;

/** The real family behind a font id — the FIRST one, never the whole stack:
 *  handed the stack, the fonts API matches the metric-override fallback and
 *  reports it loaded (the trap measure-username-scales.js is shaped around). */
function familyOf(fontId: string): string | null {
  if (families.has(fontId)) return families.get(fontId)!;
  const stack = nameFontFamily(fontId);
  const v = stack ? firstFamilyVar(stack) : null;
  const fam = v ? getComputedStyle(document.documentElement).getPropertyValue(v).split(",")[0]!.trim() || null : null;
  families.set(fontId, fam);
  return fam;
}

function measure(fam: string, text: string) {
  const key = `${fam}\n${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `600 ${SIZE}px ${fam}`;
  const ink = inkFromMetrics(ctx.measureText(text), SIZE);
  cache.set(key, ink);
  return ink;
}

function apply(el: HTMLElement, ink: { left: number; right: number }) {
  el.style.setProperty("--un-ink-l", `${ink.left}em`);
  el.style.setProperty("--un-ink-r", `${ink.right}em`);
}

/**
 * A ref for the element that wears the styled name. Measures once the face is
 * in (document.fonts.load resolves at once when it already is), then sets the
 * two vars on that element. A name with no font equipped sets nothing.
 */
export function useNameInk(fontId: string | null | undefined, text: string) {
  return useCallback((el: HTMLElement | null) => {
    if (!el || !text) return;
    // The name's length, for Type in's one-step-per-letter wipe (any face).
    el.style.setProperty("--un-n", String([...text].length));
    // Whatever this element measured for a PREVIOUS face must not stand in for
    // this one while it loads — the worst-case fallback does.
    el.style.removeProperty("--un-ink-l");
    el.style.removeProperty("--un-ink-r");
    if (!fontId || typeof document === "undefined" || !document.fonts) { delete el.dataset.inkFor; return; }
    const fam = familyOf(fontId);
    if (!fam) return;
    const spec = `600 ${SIZE}px ${fam}`;
    // Which (face, name) this element is waiting on: a slow load that lands
    // after the element moved to another face must not write onto it (the store
    // preview flips faces as fast as you point at tiles).
    const key = `${fam}\n${text}`;
    el.dataset.inkFor = key;
    if (document.fonts.check(spec, text)) {
      const ink = measure(fam, text);
      if (ink) apply(el, ink);
      return;
    }
    document.fonts.load(spec, text).then(() => {
      if (!el.isConnected || el.dataset.inkFor !== key) return;
      const ink = measure(fam, text);
      if (ink) apply(el, ink);
    }, () => { /* the worst case stays — too much room, never too little */ });
  }, [fontId, text]);
}

/**
 * The zoom that fits a previewed name into its box, so names are never cut
 * off in previews. A store tile would clip a long name at both ends, badge
 * included, and the big preview would scroll it; this shrinks it instead,
 * never below 0.4 (a higher floor still cuts an 18-letter name in a tile), and
 * still lets a preview ENLARGE a short name up to `max`. Rounded DOWN, so the
 * fit never overshoots its box.
 * `need`/`avail` are widths at zoom 1; an unmeasured box (0) is left alone.
 */
export function fitZoom(need: number, avail: number, max: number): number {
  if (need <= 0 || avail <= 0) return 1;
  return Math.floor(Math.max(0.4, Math.min(max, avail / need)) * 100) / 100;
}

/** How often a picker replays an entrance (Type in, Focus in, Stamp) so it can
 *  be seen — in chat it plays once, as the message arrives. */
const ENTRANCE_REPLAY_MS = 2600;

/**
 * Plays an entrance again: empty its slot in the animation list, force a style
 * flush, put it back. The effect worn with it matches by name in the same slot
 * and carries on; only the entrance restarts. Without the flush in between the
 * two writes collapse into none and nothing replays.
 */
function restartEntrance(el: HTMLElement) {
  const v = el.style.getPropertyValue("--un-enter");
  if (!v) return;
  el.style.setProperty("--un-enter", "none");
  void el.offsetWidth;
  el.style.setProperty("--un-enter", v);
}

/**
 * Replays the entrance on the element the returned ref lands on, while `on`.
 * For the pickers only (store, Edit profile) — a card or chat row plays it once.
 */
export function useEntranceReplay(on: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => { if (ref.current) restartEntrance(ref.current); }, ENTRANCE_REPLAY_MS);
    return () => clearInterval(id);
  }, [on]);
  return ref;
}
