// When a drifted player should be pulled back to the live edge.
//
// Pure, and separate from the players, for the same reason whepEscalation.ts
// is: the part that breaks silently is a decision, and no offline test can
// drive a real embed. Three things here are load-bearing.
//
// 1. THE SIGNAL IS GROWTH, NOT DISTANCE. On YouTube, drift is
//    getDuration() - getCurrentTime(), and getDuration() counts from the
//    moment the broadcast started — so YouTube's own 15-30s normal-latency
//    delay is inside every reading a perfectly synced viewer produces. A
//    threshold on the absolute number fires on everyone, forever. What tells
//    us a viewer actually fell behind is that the number GREW while the tab
//    was hidden.
//
// 2. THE TRIGGER IS NARROW ON PURPOSE. Correcting only on
//    return from a hidden tab catches where drift actually comes from — a
//    slept phone, a backgrounded tab — and never moves the picture while
//    someone is watching it.
//
// 3. A DELIBERATE REWIND OUTRANKS EVERYTHING. YouTube live has DVR, so a
//    viewer may be re-watching on purpose. Seeking them forward is the same
//    class of unasked-for intervention as an automatic demotion (see NO
//    AUTOMATIC DEMOTION in StreamplaceThinPlayer).

/** What a source can do about drift. A capability, not a special case. */
export type LiveEdgeLever = "seek" | "reload" | "none";

export type LiveEdgeAction = { kind: "seek" } | { kind: "reload" } | { kind: "none" };

/** Below this, the tab was flicked, not left. */
// @test-only liveEdge.test.ts asserts this threshold directly; usePlayerAdapter.ts
// is forbidden (playerAdapterWiring.test.ts) from restating it, so a test is
// this export's only legitimate consumer — it must call liveEdgeAction(), never
// re-derive the threshold itself.
export const MIN_HIDDEN_MS = 3000;
/** A player still settling has a meaningless drift reading. */
// @test-only liveEdge.test.ts asserts this threshold directly, for the same
// reason MIN_HIDDEN_MS is tagged above.
export const MIN_SINCE_LOAD_MS = 10_000;
/** Seconds of GROWTH across the hidden window before we act. */
// @test-only liveEdge.test.ts asserts this threshold directly, for the same
// reason MIN_HIDDEN_MS is tagged above.
export const DRIFT_GROWTH_S = 8;

export type LiveEdgeInput = {
  /** Seconds behind the live edge when the tab was hidden; null if unmeasurable. */
  driftAtHide: number | null;
  /** Seconds behind the live edge now, on return; null if unmeasurable. */
  driftOnReturn: number | null;
  /** How long the tab was hidden. */
  hiddenMs: number;
  /** How long this player has been mounted. */
  sinceLoadMs: number;
  /** Has the viewer deliberately seeked backward this session? */
  viewerSeeked: boolean;
  /** What this source can do about it. */
  lever: LiveEdgeLever;
};

/**
 * Decide whether to pull this player back to the live edge. Pure: no timers,
 * no DOM, no player handle.
 *
 * Ordering is deliberate. The lever is checked first so a source that cannot
 * act is never reasoned about further, and the viewer's own rewind is checked
 * before any measurement, because no drift figure justifies overriding it.
 */
export function liveEdgeAction(input: LiveEdgeInput): LiveEdgeAction {
  const { driftAtHide, driftOnReturn, hiddenMs, sinceLoadMs, viewerSeeked, lever } = input;

  if (lever === "none") return { kind: "none" };
  if (viewerSeeked) return { kind: "none" };
  if (hiddenMs < MIN_HIDDEN_MS) return { kind: "none" };
  if (sinceLoadMs < MIN_SINCE_LOAD_MS) return { kind: "none" };
  if (driftAtHide === null || driftOnReturn === null) return { kind: "none" };

  const growth = driftOnReturn - driftAtHide;
  if (growth <= DRIFT_GROWTH_S) return { kind: "none" };

  return { kind: lever };
}
