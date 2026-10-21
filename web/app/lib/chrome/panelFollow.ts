// The motion primitive every panel-window motion shares.
//
// A panel window is a bottom-anchored box inside a clipping layer whose
// bottom edge is the composer's top, and that layer rides the keyboard lift
// on the compositor. So the ONE way to move the panel's top edge smoothly is
// a `translate` of a box held at the LARGER of the two heights involved —
// the layer clips the overhang at the composer's edge, and nothing lays out
// per frame. The lift-follow (a ceiling change), the drag (a finger), the
// snap (a release) and the content-growth follow all reduce to: read where
// the box IS, hold it there with the transition suppressed, and release it
// to the stylesheet's `transition: translate` toward where it should REST.
// This file is that vocabulary; keeping it in one place is what stops four
// callers drifting into four slightly different FLIPs.
//
// `translate`, never `transform`: panel-seam-in/out own `transform`, and
// their `both` fill overrides an inline transform for the panel's whole life.
// The two independent properties add, which is also what lets a swipe-dismiss
// hand a translated box straight to the exit keyframes.

/** The element's live computed `translate` Y in px — mid-transition this is
 *  the interpolated value, which is exactly what a retarget must start from
 *  (a restart from 0 would snap the box back and re-ease). */
export function currentTranslateY(el: HTMLElement): number {
  const v = el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue("translate");
  if (!v || v === "none") return 0;
  const y = v.trim().split(/\s+/)[1];
  return y ? parseFloat(y) || 0 : 0;
}

/** The element's live computed `transform` Y in px. A browser reports a
 *  computed transform as `matrix(a, b, c, d, tx, ty)` or `matrix3d(…)` while
 *  panel-seam-in/out run (they animate `translateY(100%)`, resolved to px);
 *  jsdom hands back the inline text, so the two translate forms are read too.
 *  Anything else (a rotate, a scale) has no Y translation to report.
 *  @test-only production reaches this only through layoutTop in this same file, and the orphan gate counts other files' references only; exported so panelFollow.test.ts can pin the parsing of every form (matrix, matrix3d, translateY, translate, none) directly */
export function currentTransformY(el: HTMLElement): number {
  const v = el.ownerDocument.defaultView?.getComputedStyle(el).getPropertyValue("transform")?.trim();
  if (!v || v === "none") return 0;
  const args = v.slice(v.indexOf("(") + 1, v.lastIndexOf(")")).split(",").map((n) => parseFloat(n));
  let y = 0;
  if (v.startsWith("matrix3d(")) y = args[13] ?? 0;
  else if (v.startsWith("matrix(")) y = args[5] ?? 0;
  else if (v.startsWith("translateY(")) y = args[0] ?? 0;
  else if (v.startsWith("translate(")) y = args[1] ?? 0;
  return Number.isFinite(y) ? y : 0;
}

/** The panel's layout top within its layer, in FRACTIONAL px: its rect against
 *  the layer's, minus its own in-flight translate AND its own in-flight
 *  transform. Not `offsetTop`: that rounds to whole px, and with the layer
 *  509.8px tall the half-pixel miss became a 0.2px nudge the WRONG
 *  way on a keyboard close's first frame. The lift's transform lives on an
 *  ancestor of both rects, so it cancels; the panel's OWN transform is
 *  panel-seam-in/out's — a baseline read one frame after mount, while the
 *  entry is still sliding, must not carry the slide (the
 *  ResizeObserver's initial delivery would otherwise read the entry's
 *  progress as growth and fire a follow on every open). */
export function layoutTop(panel: HTMLElement, layer: HTMLElement): number {
  return panel.getBoundingClientRect().top - layer.getBoundingClientRect().top
    - currentTranslateY(panel) - currentTransformY(panel);
}

/** A CSS length of exactly 0 needs no unit — the X component above is
 *  always written this way ("0", never "0px"); this keeps Y consistent with
 *  it so a release-to-rest writes `translate: 0 0`, matching every existing
 *  lift-follow write this primitive was extracted from. */
function px(y: number): string {
  return y === 0 ? "0" : `${y}px`;
}

/** Put the box at `y` NOW, with the stylesheet transition suppressed. A drag
 *  calls this once per pointer move; a settle calls it once to zero the
 *  scalar in the same frame the resting box comes back. Writes
 *  `translate: 0 <y>px` (zero is written unitless, `0 0` — see `px()`). */
export function holdTranslate(panel: HTMLElement, y: number): void {
  panel.style.transitionProperty = "none";
  panel.style.translate = `0 ${px(y)}`;
}

/** How deep the box currently hangs past the layer's clip edge, published to
 *  the stylesheet as `--panel-park` so a PARKED panel's scrollable body can
 *  pad itself by exactly that much (chrome.css, `[data-detent="free"]`).
 *
 *  Why: a parked panel keeps the CAP box and is pushed down by its
 *  translate, so its bottom `y` pixels sit past the clip edge. The body is
 *  sized by that BOX, so its scroll range ends with those pixels still
 *  hidden — scrolled fully down, the last of the content (on the tip panel,
 *  the pay button) is unreachable without pulling the panel back up. Padding
 *  the content by `y` ends the scroll range where the VISIBLE region ends
 *  instead.
 *
 *  Written at REST only — never per drag frame. Padding lays out, and the
 *  whole gesture model is that the scalar moves and the box does not; a
 *  per-frame write here would put a layout back into the gesture this module
 *  exists to keep off the main thread. Both rest points call it: the drag's
 *  settle (usePanelDrag.ts) and the lift-follow's release (Window.tsx), the
 *  latter because a cap change moves a parked box without any gesture. */
export function setParkPad(panel: HTMLElement, y: number): void {
  panel.style.setProperty("--panel-park", px(Math.max(0, y)));
}

/** The FLIP release: land the box at `from` (suppressed), flush so that
 *  write is the transition's start value, hand the property back to the
 *  stylesheet's `transition: translate …`, and write `to`. The order is the
 *  whole mechanism — swap the last two and the box jumps to `to` instead. */
export function releaseTranslate(panel: HTMLElement, from: number, to: number): void {
  holdTranslate(panel, from);
  void panel.offsetHeight;
  panel.style.transitionProperty = "";
  panel.style.translate = `0 ${px(to)}`;
}
