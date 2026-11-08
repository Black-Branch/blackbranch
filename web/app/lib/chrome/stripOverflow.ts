// web/app/lib/chrome/stripOverflow.ts
// The section strip's overflow arithmetic, pure (Sections.tsx does the DOM).
//
// A strip that holds more tabs than its width scrolls sideways with its
// scrollbar hidden. An always-on edge fade would say nothing about whether
// more tabs exist (at 390 px a tab can end on its own divider inside the
// fade) and would fade a last label for nothing on a strip that fits. So the
// edge says so only when it is true: a fade AND a chevron on each side that
// has more, nothing on a side that does not.
//
// No one-letter tab (client polish Task 5b): at 390 px the chat strip holds
// less than its tabs, and a tab ending under the fade read "S›". The list
// snaps to tab starts, every programmatic move (a chevron press, the selected
// tab's reveal) lands on one of those rest positions, and a tab that does not
// fit PEEKS under the end fade — never hidden, so the strip never shows a
// blank stretch. A label that cannot show three characters clear of a fade
// band — at either edge — is covered completely instead (fadeCovers).

/**
 * Width of the fade and of the chevron's touch box on a side that has more: the
 * band a tab must clear to count as whole, and the snap padding (chrome.css).
 * Sections writes the standard mask stops from it; stripOverflow.test.ts pins
 * chrome.css's literals (mask fallbacks, snap padding, chevron width) to it —
 * CSS cannot import it, and the two drifting apart would fade a tab the strip thinks is clear.
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

/** A tab's span along the strip, in SCROLL coordinates (its left edge at scrollLeft 0). */
export type TabSpan = { x: number; w: number };

/** The visible window [lo, hi] at `scrollLeft`: the list's box less the chevron band on each side that has more. */
function view(scrollLeft: number, clientWidth: number, scrollWidth: number, edge: number): { lo: number; hi: number } {
  const start = scrollLeft > SLACK ? edge : 0;
  const end = scrollLeft + clientWidth < scrollWidth - SLACK ? edge : 0;
  return { lo: scrollLeft + start, hi: scrollLeft + clientWidth - end };
}

const isWhole = (t: TabSpan, v: { lo: number; hi: number }) => t.x >= v.lo - SLACK && t.x + t.w <= v.hi + SLACK;

/**
 * Which tabs are WHOLE at `scrollLeft`: inside the list and clear of the chevron
 * box on a side that has more (the rest peek under the fade).
 * @test-only exported so stripOverflow.test.ts can say which tabs a rest position shows whole
 * (the strip itself only needs the same test inside pageTarget / revealTarget).
 */
export function wholeTabs(tabs: readonly TabSpan[], scrollLeft: number, clientWidth: number, scrollWidth: number, edge = STRIP_EDGE_PX): boolean[] {
  const v = view(scrollLeft, clientWidth, scrollWidth, edge);
  return tabs.map((t) => isWhole(t, v));
}

/**
 * Where the strip rests with a tab first: its start `edge` in (chrome.css
 * `scroll-padding-inline`, so these ARE the browser's snap positions), clamped
 * to the scroll range — the first tab rests flush at 0.
 * @test-only exported so stripOverflow.test.ts can name the rest positions it checks targets against.
 */
export function restFor(x: number, clientWidth: number, scrollWidth: number, edge = STRIP_EDGE_PX): number {
  return Math.min(Math.max(x - edge, 0), Math.max(scrollWidth - clientWidth, 0));
}

/** The first rest position (tabs 0…i, in order) that `ok` accepts and that shows tab `i` whole; else tab i's own. */
function firstShowing(tabs: readonly TabSpan[], i: number, clientWidth: number, scrollWidth: number, edge: number, ok: (s: number) => boolean): number {
  for (let j = 0; j <= i; j++) {
    const s = restFor(tabs[j]!.x, clientWidth, scrollWidth, edge);
    if (ok(s) && isWhole(tabs[i]!, view(s, clientWidth, scrollWidth, edge))) return s;
  }
  return restFor(tabs[i]!.x, clientWidth, scrollWidth, edge);
}

/**
 * One chevron press. `›` (1): the first tab not whole past the view lands at
 * the start (its rest position). `‹` (−1): the tab just before the view comes
 * back whole at the end, with as many before it as fit. Always a rest position,
 * so the snap never moves it again and a page never ends inside a tab.
 */
export function pageTarget(tabs: readonly TabSpan[], scrollLeft: number, clientWidth: number, scrollWidth: number, dir: 1 | -1, edge = STRIP_EDGE_PX): number {
  const max = Math.max(scrollWidth - clientWidth, 0);
  const v = view(scrollLeft, clientWidth, scrollWidth, edge);
  if (dir === 1) {
    for (const t of tabs) {
      if (t.x + t.w <= v.hi + SLACK) continue;
      const s = restFor(t.x, clientWidth, scrollWidth, edge);
      if (s > scrollLeft + SLACK) return s;
    }
    return max;
  }
  const first = tabs.findIndex((t) => t.x >= v.lo - SLACK);
  if (first <= 0) return 0;
  const s = firstShowing(tabs, first - 1, clientWidth, scrollWidth, edge, (at) => at < scrollLeft - SLACK);
  return Math.min(s, Math.max(scrollLeft, 0));
}

/**
 * The scroll position that brings tab `i` into full view — the least move, and
 * always a rest position — or null when it is already whole (never fight a
 * hand scroll that left it in view).
 */
export function revealTarget(tabs: readonly TabSpan[], i: number, scrollLeft: number, clientWidth: number, scrollWidth: number, edge = STRIP_EDGE_PX): number | null {
  const t = tabs[i];
  if (!t) return null;
  const v = view(scrollLeft, clientWidth, scrollWidth, edge);
  if (isWhole(t, v)) return null;
  if (t.x < v.lo) return restFor(t.x, clientWidth, scrollWidth, edge);
  return firstShowing(tabs, i, clientWidth, scrollWidth, edge, (at) => at > scrollLeft + SLACK);
}

/**
 * A tab label's GLYPHS along the strip, in scroll coordinates (measured with a
 * Range per character — the label's box is as wide as its bold reserve, wider
 * than a non-selected label's glyphs): `x` the first glyph's left, `w` to the
 * last glyph's right, `head` the right edge of its first PEEK_MIN_CHARS glyphs,
 * `tail` the left edge of its last PEEK_MIN_CHARS.
 */
export type LabelSpan = { x: number; w: number; head: number; tail: number };

/** Fewer characters than this beside a chevron is a sliver, not a word (the "S›" of Task 5). */
export const PEEK_MIN_CHARS = 3;

/**
 * How far in from each edge the strip is made fully transparent, or null for
 * that side's standard fade (transparent to edge/2, opaque from edge).
 *
 * The rule, the same on both sides: a label that touches a side's fade band
 * and would show any of itself must show PEEK_MIN_CHARS characters fully clear
 * of the band; if it cannot, it is covered completely — the end side from its
 * first letter, the start side through its last letter — so the strip never
 * shows "S›" or "‹e". Whether the label starts before, inside or at the band
 * makes no difference: only its clear characters count.
 */
export function fadeCovers(labels: readonly LabelSpan[], scrollLeft: number, clientWidth: number, scrollWidth: number, edge = STRIP_EDGE_PX): { start: number | null; end: number | null } {
  let start: number | null = null;
  let end: number | null = null;
  if (scrollLeft + clientWidth < scrollWidth - SLACK) {
    const opaque = scrollLeft + clientWidth - edge;
    const gone = scrollLeft + clientWidth - edge / 2;
    for (const l of [...labels].sort((a, b) => a.x - b.x)) {
      if (l.x >= gone || l.x + l.w <= opaque) continue;
      if (l.head > opaque + SLACK) { end = scrollLeft + clientWidth - l.x; break; }
    }
  }
  if (scrollLeft > SLACK) {
    const opaque = scrollLeft + edge;
    const gone = scrollLeft + edge / 2;
    for (const l of [...labels].sort((a, b) => b.x - a.x)) {
      if (l.x + l.w <= gone || l.x >= opaque) continue;
      if (l.tail < opaque - SLACK) { start = l.x + l.w - scrollLeft; break; }
    }
  }
  return { start, end };
}
