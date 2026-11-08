// The panel gesture's arithmetic — pure, no DOM, node-tested. The whole
// vertical gesture is ONE scalar: the panel's translate Y on a box held at cap
// height (usePanelDrag.ts). 0 = the cap (the panel's top sits on the ceiling),
// `fit` = contentFit (the same place the resting content-fit box sits), and
// BELOW `fit` the scalar is a free position: the slide down to close exists
// only at a minimum height, otherwise the window can be repositioned without
// closing — so, say, the chat appearance menu can be pulled down to see the
// chat it is changing. Above contentFit the detents are contentFit and cap
// only — nothing free-form there. A task window has fit = 0: no resize range;
// everything below its cap is free.
//
// Every number here is a PLAN-TIME value judged on device. Change them here —
// the tests pin the shape against the constants, so a retune is a one-line
// edit with no test to re-spell.

/** Finger travel below which a press is a tap, not a drag. */
export const DRAG_SLOP_PX = 6;
/** The least of the box that may stay showing above the composer: a release
 *  with less than this visible dismisses (L2.1's "slide down to close … at a
 *  minimum height"). Sized as the handle plus a sliver of content — the band
 *  (`--chrome-window-h`, 30px on a phone, the pill inside it — slim headers,
 *  round 2a) is 30px, so the ✕ and the grabber are always reachable on a parked
 *  window. A release with MORE than this showing, below contentFit, is a
 *  position: the box stays exactly there.
 *  @test-only production applies this through releaseTarget/cancelTarget in this same file — nothing outside reads the number; exported so the tests can pin the shape AGAINST the constant instead of re-spelling it (panePager.ts's MOUNT_WINDOW precedent) */
export const MIN_VISIBLE_PX = 72;
/** px/ms; a downward release faster than this is a flick. Sampled on the
 *  scalar, which is 1:1 with the finger everywhere, so the finger's own speed
 *  is the number. In the free range a flick DISMISSES — the fast path out
 *  of a parked window — so a repositioning drag released quickly closes it.
 *  If that bites on device, this is the number to raise.
 *  @test-only production applies this through releaseTarget in this same file — nothing outside reads the number; exported so the tests can pin the shape AGAINST the constant (panePager.ts's MOUNT_WINDOW precedent) */
export const FLICK_VY = 0.6;
/** Above the cap there is NO rubber: the scalar clamps at 0. The gesture's box
 *  is cap height with its bottom on the composer, so a negative scalar would
 *  lift the whole box — top clipped by the layer, bottom detached from the
 *  composer (a 14px seam gap on the first prod probe). The panel never grows
 *  past the pane, so there is nothing above the cap to strain toward. Below
 *  the composer it clamps at the cap height: fully hidden is as far as a
 *  position goes, and the exit runs from wherever the finger lets go. */
/** The velocity is taken over at least this much of the gesture's tail — and
 *  the gesture's sample buffer is pruned to TWICE this (usePanelDrag.ts), so
 *  the window's anchor can never be a sample from earlier in the drag. */
export const VELOCITY_WINDOW_MS = 80;

/** The scalar for a finger that started at `startY` and has moved `dy`
 *  (positive = down): 1:1 with the finger, clamped to [0, capH]. */
export function dragOffset(startY: number, dy: number, capH: number): number {
  const y = startY + dy;
  if (y < 0) return 0;
  if (y > capH) return capH;
  return y;
}

type Detent = { kind: "detent"; y: number };
/** A parked position below contentFit — the box rests at exactly `y`. */
type Free = { kind: "free"; y: number };
type Rest = Detent | Free;
type Release = Rest | { kind: "dismiss" };

/** The lowest scalar that still shows MIN_VISIBLE_PX of the box. */
const floorOf = (capH: number) => capH - MIN_VISIBLE_PX;

/** THE nearest-detent rule ABOVE contentFit, in one place: contentFit if the
 *  box is past the midpoint between the two detents, the cap otherwise.
 *  `fit <= 0` (a task, or a panel whose content already fills the pane) has
 *  only the cap. Callers reach it only for `y <= fit`; below contentFit the
 *  scalar is a position, not a detent choice (`cancelTarget`).
 *  @test-only production reaches it only through releaseTarget/cancelTarget in this same file (L2.1 moved the hook's own cancel path onto cancelTarget); exported so the tests can pin the midpoint rule on its own */
export function nearestDetent(y: number, fit: number): Detent {
  return { kind: "detent", y: fit <= 0 ? 0 : y > fit / 2 ? fit : 0 };
}

/** Where a CANCEL goes — a pointercancel from the pager, or a keyboard commit
 *  under a held finger. A cancel carries no velocity and must never dismiss,
 *  however far the finger had dragged: above contentFit the nearest detent;
 *  below it the position itself, raised to the floor if the finger had the
 *  box under the minimum. When the pane is too short for a free range (the
 *  floor at or above contentFit — a keyboard-shrunk pane) contentFit is the
 *  lowest resting place. */
export function cancelTarget(y: number, fit: number, capH: number): Rest {
  if (y <= fit) return nearestDetent(y, fit);
  const floor = floorOf(capH);
  if (floor <= fit) return { kind: "detent", y: fit };
  return { kind: "free", y: Math.min(y, floor) };
}

/** Where a RELEASE goes. `y` is the current scalar, `vy` the release velocity
 *  in px/ms (positive = down). Below contentFit: under the minimum, or a
 *  downward flick, dismisses (a flick from the cap stops at contentFit — one
 *  gesture is one step; nobody flings a window off the screen by accident from
 *  the top); an upward flick goes back to contentFit; anything else is a
 *  position — the box stays where it was let go. Above contentFit: a flick
 *  picks its direction's detent, a slow release the nearest one. The minimum
 *  is judged only BELOW contentFit, so a card shorter than MIN_VISIBLE_PX
 *  still rests at its own contentFit — it simply has no free range. */
export function releaseTarget(y: number, vy: number, fit: number, capH: number): Release {
  if (y > fit) {
    if (y > floorOf(capH) || vy > FLICK_VY) return { kind: "dismiss" };
    if (vy < -FLICK_VY) return { kind: "detent", y: fit };
    return { kind: "free", y };
  }
  if (fit <= 0) return { kind: "detent", y: 0 };
  if (vy > FLICK_VY) return { kind: "detent", y: fit };
  if (vy < -FLICK_VY) return { kind: "detent", y: 0 };
  return nearestDetent(y, fit);
}

export type Sample = { t: number; y: number };

/** Release velocity in px/ms from the gesture's recent samples: the last
 *  sample against the newest one that is at least VELOCITY_WINDOW_MS older
 *  (or the oldest available). Zero elapsed time is zero speed, not Infinity. */
export function velocity(samples: readonly Sample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  let i = samples.length - 2;
  while (i > 0 && last.t - samples[i]!.t < VELOCITY_WINDOW_MS) i--;
  const first = samples[i]!;
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/** A TOP panel's release and cancel (usePanelPull.ts) — THE SAME rule as a
 *  bottom panel's, asked in the terms a top panel has. A top panel is SIZED by
 *  its handle (its band would leave through the layer's top edge if it were
 *  translated), so it knows how much of it shows (`v`, 0 = shut, `capH` = the
 *  whole visible pane), its own content-fit size (`fitV`; a task passes `capH`
 *  — its only detent is the full pane, everything under it is a position) and
 *  the release speed TOWARD OPEN (`vOpen`, px/ms; for a top panel that is
 *  down). The bottom panel's scalar is how far its box sits below the cap, and
 *  its positive speed is toward closed, so the direction is turned around
 *  ONCE, here: y = capH − v, vy = −vOpen. #234 (k): "slide down pages don't
 *  act like slide up pages" — before this the top panel had a rule of its own
 *  (16px snap zones, a flick up closing only from under half its start, a
 *  travel that stopped at the clear strip).
 *  slideBothWays.render.test.ts runs the two side by side over a grid. */
export type SizeRest = { kind: "dismiss" } | { kind: "fit" } | { kind: "cap" } | { kind: "free"; v: number };

function bySize(r: Release, capH: number): SizeRest {
  if (r.kind === "dismiss") return r;
  if (r.kind === "free") return { kind: "free", v: capH - r.y };
  return r.y === 0 ? { kind: "cap" } : { kind: "fit" };
}

export function releaseBySize(v: number, vOpen: number, fitV: number, capH: number): SizeRest {
  return bySize(releaseTarget(capH - v, -vOpen, Math.max(0, capH - Math.min(fitV, capH)), capH), capH);
}

export function cancelBySize(v: number, fitV: number, capH: number): SizeRest {
  return bySize(cancelTarget(capH - v, Math.max(0, capH - Math.min(fitV, capH)), capH), capH);
}
