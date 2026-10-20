// The compact bar's scroll-direction reveal: in mobile compact the tab bar
// behaves like a phone browser's chrome — scrolling UP (finger swiping down)
// reveals it, scrolling DOWN hides it, and it auto-hides after a couple of
// seconds. Page swipes do not touch it at all: a reveal on pager motion would
// make the bar flicker in and out on every pane change.
//
// This file is the PURE half — a signed-delta accumulator with a threshold,
// so pixel-level jitter (scroll anchoring, momentum tail frames) cannot flap
// the bar. The DOM half (a capture-phase scroll listener on the chat panel,
// per-element previous-scrollTop tracking, the no-scroll drag fallback) lives
// in ChatSidebar, which owns the compact state the emits drive.

/** How long a revealed bar stays before auto-hiding with no further
 *  up-scroll — "a couple seconds". */
export const BAR_AUTO_HIDE_MS = 2000;

export type BarScrollReveal = {
  /** Feed one scroll delta (positive = scrolled down). Emits `up`/`down` when
   *  the accumulated run in one direction crosses the threshold. */
  delta(d: number): void;
  /** Forget any accumulated run (e.g. the listener re-attached). */
  reset(): void;
};

export function createBarScrollReveal(opts: {
  up: () => void;
  down: () => void;
  /** Pixels of NET travel in one direction before an emit (default 12). */
  threshold?: number;
}): BarScrollReveal {
  const threshold = opts.threshold ?? 12;
  let accum = 0;
  return {
    delta(d) {
      if (d === 0) return;
      // A direction change starts a fresh run — a long scroll down must not
      // bank "credit" that a tiny flick up then spends instantly.
      if ((accum > 0 && d < 0) || (accum < 0 && d > 0)) accum = 0;
      accum += d;
      if (accum <= -threshold) { accum = 0; opts.up(); }
      else if (accum >= threshold) { accum = 0; opts.down(); }
    },
    reset() { accum = 0; },
  };
}
