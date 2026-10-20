// The player fold's mount lifecycle.
//
// Lives here rather than inline in StreamView so it can be RUN by a test
// instead of source-scanned: every defect this hook exists to prevent —
// a collapse that never releases the player, an unfold that cannot
// transition — is a sequence of events over time, which a scan cannot see.
//
// The shape, and why:
//
//  · The fold REGION stays mounted at all times. A wrapper that unmounts while
//    folded remounts on unfold already at `grid-template-rows: 1fr`, and an
//    element with no prior computed value does not transition — so the collapse
//    would animate and the expand snap. Both directions must animate.
//  · The PLAYER unmounts at the END of the collapse, not at its start, so a
//    folding player keeps playing for the duration — an audible cut before the
//    visual one is worse.
//  · `transitionend` is not guaranteed to arrive. `grid-template-rows` is not
//    interpolable in Safari < 16 or Firefox < 127 — there the change applies in
//    one frame and NO transition event fires at all — and `prefers-reduced-
//    motion` sets `transition: none` for the same reason. Without a fallback
//    the player would stay mounted and AUDIBLE behind a zero-height region,
//    which inverts "fold = off".

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long to wait for the collapse's `transitionend` before unmounting the
 * player anyway. A hand-copy of `--anim-slow` (defined in globals.css as 300ms)
 * plus slack for a busy main thread, so the fallback can never cut a normal
 * collapse short — the real event arrives first and clears it. If `--anim-slow`
 * changes, this constant must be updated in sync, or the unmount fallback will
 * trigger before the fold's CSS transition finishes.
 */
// @test-only usePlayerFold.render.test.ts ticks the clock to these boundaries to
// prove the fallback waits out a full collapse and still fires; nothing else
// needs them, and a hard-coded duplicate in the test would be the drift.
export const FOLD_ANIM_MS = 300;
/** Slack for a busy main thread, so the fallback can never pre-empt the event. */
const FOLD_UNMOUNT_SLACK_MS = 250;
// @test-only same reason as FOLD_ANIM_MS above — the test's tick boundary.
export const FOLD_UNMOUNT_FALLBACK_MS = FOLD_ANIM_MS + FOLD_UNMOUNT_SLACK_MS;

export type PlayerFold = {
  /** Render the player subtree? Stays true through the collapse. */
  playerMounted: boolean;
  /** Call BEFORE flipping `folded` — arms the collapse the user just asked for. */
  armFold: () => void;
  /** Hand to the fold region's `onTransitionEnd`. */
  onRegionTransitionEnd: (e: { propertyName: string }) => void;
};

export function usePlayerFold(folded: boolean): PlayerFold {
  const [playerMounted, setPlayerMounted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearFallback = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cleanup only — nothing is set here, because `react-hooks/set-state-in-effect`
  // is a hard error in this repo and an effect chasing a value already known is
  // a cascading render.
  useEffect(() => clearFallback, [clearFallback]);

  const armFold = useCallback(() => {
    clearFallback();
    // Reduced motion substitutes an instant change, so there is no transition
    // to ride and no event to wait for: release the player in the same commit.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlayerMounted(false);
      return;
    }
    setPlayerMounted(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPlayerMounted(false);
    }, FOLD_UNMOUNT_FALLBACK_MS);
  }, [clearFallback]);

  const onRegionTransitionEnd = useCallback(
    (e: { propertyName: string }) => {
      // Only the fold's own property, and only on the way in: the region also
      // transitions open, and that direction must not unmount anything.
      if (e.propertyName !== "grid-template-rows" || !folded) return;
      clearFallback();
      setPlayerMounted(false);
    },
    [folded, clearFallback],
  );

  return { playerMounted, armFold, onRegionTransitionEnd };
}
