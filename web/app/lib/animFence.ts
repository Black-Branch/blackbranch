"use client";

import { useCallback, useEffect, type RefObject } from "react";

// Off-screen fence for per-row infinite chat animations (most running cycles on
// a full chat page animate rows nobody can see). One shared IntersectionObserver marks
// rows that leave the viewport; globals.css pauses the row's infinite
// animations ([data-anim-off] … { animation-play-state: paused }). Rows are
// only observed while they actually carry an infinite animation (the caller
// passes `active`), so the observed set stays small.
//
// The mark is a DATA-ATTRIBUTE, not a class, and that is load-bearing:
// React rewrites `className` wholesale whenever the row re-renders (memo rows
// still re-render on badge/context changes), which would silently strip an
// imperatively-added class — and no further observer callback would fire to
// restore it, because the row's intersection never changed. React's DOM diff
// never touches attributes it didn't render, so an attribute set here survives
// every re-render.
//
// Paused, not none: the animation resumes where it left off when the row
// scrolls back in, with no restart snap.

let observer: IntersectionObserver | null = null;
// Observed box → the elements that carry its mark. A row marks itself; a styled name is marked
// through its parent box (see useAnimFenceRef), and two names can share one box.
const marks = new Map<Element, Set<Element>>();

function watch(io: IntersectionObserver, box: Element, el: Element) {
  let set = marks.get(box);
  if (!set) { set = new Set(); marks.set(box, set); io.observe(box); }
  set.add(el);
}

function unwatch(io: IntersectionObserver, box: Element, el: Element) {
  el.removeAttribute("data-anim-off");
  const set = marks.get(box);
  if (!set) return;
  set.delete(el);
  if (set.size === 0) { marks.delete(box); io.unobserve(box); }
}

function fenceObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return null;
  if (!observer) {
    // SEEN = A NON-ZERO AREA, not `isIntersecting`. IntersectionObserver
    // reports a zero-area EDGE TOUCH as intersecting (ratio 0) — and the Home
    // tab's hidden chat pane sits exactly on its scroll container's clip edge,
    // so every row in it would read as on screen forever and keep the page
    // rendering at full rate. The 0.001 threshold makes "a sliver came into
    // view" fire a callback, since a threshold of 0 alone does not re-fire on
    // 0 → >0.
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const seen = e.isIntersecting && e.intersectionRatio > 0;
        for (const el of marks.get(e.target) ?? []) {
          if (seen) el.removeAttribute("data-anim-off");
          else el.setAttribute("data-anim-off", "");
        }
      }
    }, { threshold: [0, 0.001] });
  }
  return observer;
}

/**
 * Observe `ref`'s element while `active`; off-screen it gets `data-anim-off`
 * and its infinite animations pause. Pass `active` only when the row really
 * has one (pi-cycle, animated username style) — observing static rows is
 * harmless but pointless.
 */
export function useAnimFence(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    const io = fenceObserver();
    if (!el || !io) return;
    watch(io, el, el);
    return () => unwatch(io, el, el);
  }, [ref, active]);
}

/**
 * The callback-ref form, for an element that carries its OWN infinite
 * animation rather than a row around one — a styled name on the Home
 * leaderboard, the pinned banner, a profile card, a store/editor preview, the
 * credit overlay (a name glow below the fold is a glow nobody can see).
 * `also` is another ref the same element
 * already uses (useNameInk's); both run on attach. React 19 runs the returned
 * cleanup on detach.
 *
 * It measures the name's PARENT box and marks the name. The name's own box is the wrong
 * measuring stick: an entrance (Type in) starts at a zero-area clip-path, which the browser
 * reports exactly like an off-screen edge touch, so observing the name paused the entrance on
 * that first frame and the name stayed invisible.
 */
export function useAnimFenceRef<T extends HTMLElement>(active: boolean, also?: (el: T | null) => void) {
  return useCallback((el: T | null) => {
    also?.(el);
    const io = fenceObserver();
    if (!active || !el || !io) return;
    const box = el.parentElement ?? el;
    watch(io, box, el);
    return () => unwatch(io, box, el);
  }, [active, also]);
}
