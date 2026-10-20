"use client";

import { useSyncExternalStore } from "react";
import { Q_NARROW } from "./deviceQueries.ts";

// matchMedia fires only when the query's truth CHANGES, not on every resize
// pixel, so subscribing is cheap.
function subscribe(onChange: () => void) {
  const mql = window.matchMedia(Q_NARROW);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/**
 * True when the viewport is below the narrow breakpoint.
 *
 * LAYOUT ONLY — this is not a device check. A coarse-pointer tablet at
 * 800px is NOT narrow but IS `deviceClass() === "mobile"`; the two questions
 * disagree there deliberately. See deviceQueries.ts.
 *
 * useSyncExternalStore is the right primitive for client-only external state:
 * the server snapshot is `false` (desktop) so it MATCHES the SSR'd HTML — no
 * hydration mismatch — and React then syncs to the real viewport value in the
 * same commit, before paint where it can, instead of a mount-effect flip that
 * renders the desktop branch for a frame on every cold mobile load.
 *
 * There is deliberately no `usePointerCoarse` companion: every consumer of
 * that question reads the constant directly inside an effect or a non-React
 * module, and a hook nobody calls is an orphaned mechanism. `useTouchPrimary`
 * (useTouchPrimary.ts) exists because the terminal's key row needs that
 * question in a render.
 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    subscribe,
    narrowViewportNow,   // client snapshot
    () => false,         // server snapshot (desktop-first)
  );
}

/**
 * The same question, answered ONCE, outside React's render cycle.
 *
 * For the callers that want a viewport answer but must not re-answer it: the
 * hook is a live subscription, so anything derived from it changes when the
 * viewer resizes their window, and some derivations are start-of-playback
 * decisions that cannot be re-taken without restarting what they configured
 * (StreamView's `startMuted`). Client-only — `window` is read directly, so this
 * belongs in an effect or an event, never in a render path that also runs on
 * the server.
 */
export function narrowViewportNow(): boolean {
  return window.matchMedia(Q_NARROW).matches;
}
