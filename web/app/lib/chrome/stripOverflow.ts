// web/app/lib/chrome/stripOverflow.ts
// The section strip's overflow arithmetic, pure (Sections.tsx does the DOM).
//
// A strip that holds more tabs than its width scrolls sideways with its
// scrollbar hidden. An always-on edge fade would say nothing about whether
// more tabs exist (at 390 px a tab can end on its own divider inside the
// fade) and would fade a last label for nothing on a strip that fits. So the
// edge says so only when it is true: a fade AND a chevron on each side that
// has more, nothing on a side that does not.

/**
 * Width of the fade on a side that has more, and the band the active tab is kept out of.
 * @test-only exported so stripOverflow.test.ts can pin chrome.css's 40px mask stops to this
 * number — CSS cannot import it, and the two drifting apart would fade a tab the strip thinks is clear.
 */
export const STRIP_EDGE_PX = 40;

/** A sub-pixel layout (fractional scrollLeft, a 1px trailing divider) is not "more". */
const SLACK = 1;

export type StripMore = "start" | "end" | "both" | null;

/** Which sides of a horizontally scrolled strip hold tabs past the visible edge. */
export function overflowEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): StripMore {
  const start = scrollLeft > SLACK;
  const end = scrollLeft + clientWidth < scrollWidth - SLACK;
  return start && end ? "both" : start ? "start" : end ? "end" : null;
}

/**
 * How far to move `scrollLeft` so a tab sits clear of the edge band (its fade
 * and chevron). `left`/`right` are the tab's edges relative to the strip's
 * visible box. A side with nothing more past it needs no clearance — the first
 * tab may sit flush at 0 and the last flush at the end (the browser clamps the
 * write anyway). 0 = leave it.
 */
export function revealDelta(left: number, right: number, scrollLeft: number, clientWidth: number, scrollWidth: number, edge = STRIP_EDGE_PX): number {
  const moreStart = scrollLeft > SLACK;
  const moreEnd = scrollLeft + clientWidth < scrollWidth - SLACK;
  if (moreStart && left < edge) return left - edge;
  if (moreEnd && right > clientWidth - edge) return right - (clientWidth - edge);
  return 0;
}

/** One chevron press: most of a strip's width, never less than a tab's worth. */
export function pageStep(clientWidth: number, edge = STRIP_EDGE_PX): number {
  return Math.max(clientWidth - 2 * edge, 80);
}
