// web/app/components/chrome/Sections.tsx
"use client";

// Sections — the "tabs" tier of the chrome system, in the Console language:
// a band with a HOLE where the active section is (the body shows through),
// a 2px cap that slides, and a heavier label. Three signals, and the tab is
// physically joined to what it opens (NN/g: "make the panel evident").
//
// The band (shade + cap) is the CONTAINER's: inside a `Bar band` the Band
// spans the whole bar and this strip only reports where the hole goes,
// through BandContext. Standalone (ModPanel, Store — no Bar around it) the
// strip wraps itself in its own Band, so both look the same.
// Either way this file never touches the shade or the cap: it measures, calls
// the pure arithmetic in app/lib/chrome/indicatorBox.ts, and hands the Band
// its ONE box as a list — `band.paint([box], animate)`, or `[]` for nothing
// selected. (The Band paints up to two; only the split view's Panes fills the
// second slot.) `floating` density is the exception at both ends: it renders
// no Band and adopts none, so a folded pill inside a Bar cannot punch that
// bar's hole.
//
// Geometry is measured in BAND space with rect deltas (tab rect − frame
// rect): the strip may sit after a leading slot inside a bar, and the list
// scrolls, and a rect delta is right in both cases where offsetLeft is not.
//
// Measurement is TWO effects, not one, because they change for different
// reasons. Effect A wires the passive `scroll` listener and the
// `ResizeObserver` once per SET of keys — the listeners call `applyRef.current`
// so a selection or pager tick never tears them down and re-subscribes them.
// Effect B runs on a selection/pager change: it scrolls the active tab into
// view (never on a scroll/resize follow-up — that would fight a viewer's own
// scroll) and re-measures, animating only when nothing external is driving it
// (`progress === undefined`) — a pager-driven tick must not lag a finger.
// The scroll-into-view in effect B is itself a `scrollLeft` write, which fires
// effect A's own scroll listener; a `programmatic` ref flag tells that
// follow-up to keep the selection's animation instead of snapping like a
// hand-scroll would.
//
// Overflow: the list scrolls sideways with no scrollbar, so the strip has to
// SAY when tabs sit past an
// edge. And it never shows a one-letter tab or a blank stretch (Task 5b): the
// list snaps to item starts, a chevron press pages to one (stripOverflow
// pageTarget), a selection change brings the tab into full view
// (revealTarget), a tab that does not fit peeks under the end fade, and a label
// that cannot show three characters clear of either fade band is covered
// completely (fadeCovers → the --strip-{start,end}-{t,o} mask stops on the
// wrapper), so the strip never reads "S›" or "‹e". `trail` (the chat bar's "+" on a phone)
// scrolls as the list's last item, OUTSIDE the tablist, which owns only tabs.
// Effect A's same listeners mark the wrapper `data-more` = start / end /
// both (app/lib/chrome/stripOverflow.ts); chrome.css turns that into a fade
// plus a chevron on exactly the sides that have more, and nothing at all when
// everything fits — no layout shift, the chevrons are absolutely positioned
// over the fade. The chevrons are pointer-only (tabIndex −1, aria-hidden): the
// keyboard already reaches every tab through the tablist's arrows / Home / End,
// and a second stop per side would only be noise in the tab order.
//
// `value: null` is "nothing selected" (the collapsed dock): no hole, no cap.
// `progress` is the pager contract: a fractional index from a
// horizontal pane scroller. When present the cap and hole follow it instead
// of `value`; clicks still call onChange.

import { useContext, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { CaretLeft, CaretRight, X } from "@phosphor-icons/react/dist/ssr";
import { useTabList, type TabItem } from "@/app/lib/chrome/useTabList";
import { interpolateBox, type Box } from "@/app/lib/chrome/indicatorBox";
import { BandContext } from "@/app/lib/chrome/bandContext";
import { fadeCovers, overflowEdges, pageTarget, revealTarget, PEEK_MIN_CHARS, STRIP_EDGE_PX, type LabelSpan, type TabSpan } from "@/app/lib/chrome/stripOverflow";
import { Band } from "./Band";

export type SectionsProps<K extends string> = {
  items: readonly TabItem<K>[];
  value: K | null;
  onChange: (key: K) => void;
  label: string;
  /** `band` (default): inside a window band or a bar. `floating`: the folded chat pill — no band, pill tabs. */
  density?: "band" | "floating";
  /** Fractional index (0 … n−1) from a pager; the indicator follows it instead of `value`. */
  progress?: number;
  /** Called from the ✕ on an active `closable` item. */
  onClose?: (key: K) => void;
  /** A control that scrolls WITH the tabs, after the last one (the chat bar's "+" on a phone). */
  trail?: ReactNode;
};

/** The strip's items in order: its tabs, then the trailing control's slot when there is one. */
function items(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"], .chrome-sections-trail'));
}

/** Each item's span in the list's SCROLL coordinates (a rect delta plus scrollLeft — right under a leading slot and a scrolled list alike). */
function spansOf(list: HTMLElement, els: readonly HTMLElement[]): TabSpan[] {
  const left = list.getBoundingClientRect().left - list.scrollLeft;
  return els.map((t) => { const r = t.getBoundingClientRect(); return { x: r.left - left, w: r.width }; });
}

/**
 * Each tab label's GLYPHS in scroll coordinates (fadeCovers): a Range over its
 * text, never the label's box — the box is as wide as the bold reserve, wider
 * than a non-selected label's letters.
 */
function labelsOf(list: HTMLElement): LabelSpan[] {
  // Every browser has Range.getBoundingClientRect (CSSOM View); jsdom does not,
  // and a mount there (other render tests) gets the standard fades.
  if (typeof document.createRange().getBoundingClientRect !== "function") return [];
  const left = list.getBoundingClientRect().left - list.scrollLeft;
  const out: LabelSpan[] = [];
  for (const el of Array.from(list.querySelectorAll<HTMLElement>(".chrome-tab-label > span"))) {
    const text = el.firstChild;
    const n = text?.textContent?.length ?? 0;
    if (!text || !n) continue;
    const glyphs = (a: number, b: number) => {
      const range = document.createRange();
      range.setStart(text, a);
      range.setEnd(text, b);
      return range.getBoundingClientRect();
    };
    const k = Math.min(PEEK_MIN_CHARS, n);
    const all = glyphs(0, n);
    out.push({ x: all.left - left, w: all.width, head: glyphs(0, k).right - left, tail: glyphs(n - k, n).left - left });
  }
  return out;
}

export function Sections<K extends string>(props: SectionsProps<K>) {
  const band = useContext(BandContext);
  const strip = <Strip {...props} />;
  // Floating density has no band at all; band density adopts the container's
  // Band or, standalone, renders its own.
  if (props.density === "floating") return strip;
  return band ? strip : <Band>{strip}</Band>;
}

function Strip<K extends string>({
  items: tabItems, value, onChange, label, density = "band", progress, onClose, trail,
}: SectionsProps<K>) {
  // Floating density renders no Band and adopts none: a folded chat pill that
  // happened to sit inside a Bar's Band would otherwise punch that bar's hole.
  const ctx = useContext(BandContext);
  const band = density === "floating" ? null : ctx;
  const { active, listProps, tabProps } = useTabList({ items: tabItems, value, onChange, label });
  const listRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Holds the latest `apply` so effect A's listeners always call the current
  // measurement/animation logic without needing `active`/`progress` in their
  // own deps (that churn was tearing down and re-wiring the ResizeObserver on
  // every tick of a pager-driven scroll).
  const applyRef = useRef<(animate: boolean) => void>(() => {});
  // Set just before effect B moves `list.scrollLeft` itself, so the scroll
  // listener (effect A) can tell "the viewer scrolled" from "we just did".
  const programmatic = useRef(false);
  // Re-measure when the SET of keys changes, not when the array identity does
  // (a consumer mapping items inline would otherwise re-run this every render).
  // The trailing slot is part of the set: its arrival changes the scroll width.
  const keySig = tabItems.map((t) => t.key).join("|") + (trail ? "|+trail" : "");

  // Effect A: wire the passive listeners once per key set.
  useLayoutEffect(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    if (!list || !wrap) return;
    const els = items(list);
    // Written to the DOM, not to state: a scroll must not re-render the strip.
    // Each side's fade is the standard ramp, or a hard stop that covers a
    // label unable to show three characters clear of the band.
    const mark = () => {
      const more = overflowEdges(list.scrollLeft, list.clientWidth, list.scrollWidth);
      if (more) wrap.dataset.more = more;
      else delete wrap.dataset.more;
      const cover = fadeCovers(labelsOf(list), list.scrollLeft, list.clientWidth, list.scrollWidth);
      for (const side of ["start", "end"] as const) {
        const c = cover[side];
        wrap.style.setProperty(`--strip-${side}-t`, `${c ?? STRIP_EDGE_PX / 2}px`);
        wrap.style.setProperty(`--strip-${side}-o`, `${c ?? STRIP_EDGE_PX}px`);
      }
    };
    const follow = () => {
      mark();
      if (programmatic.current) { programmatic.current = false; applyRef.current(true); }
      else applyRef.current(false);
    };
    mark();
    list.addEventListener("scroll", follow, { passive: true });
    const ro = new ResizeObserver(follow);
    ro.observe(list);
    for (const el of els) ro.observe(el);
    return () => { list.removeEventListener("scroll", follow); ro.disconnect(); };
  }, [keySig]);

  // Effect B: measure the current selection (or pager progress) and hand the
  // resulting box to the Band, scrolling the active tab into view first.
  //
  // The band frame is read INSIDE `apply`, at call time, never here. The Band
  // renders the element the frame ref points at as this strip's ANCESTOR, and
  // React attaches a host ref only after every descendant's layout effect has
  // run — so on the first commit `band.frame.current` is still null. An effect
  // that reads it up front bails before publishing `applyRef.current`, the
  // ResizeObserver's first delivery hits the no-op initialiser, and (these deps
  // all being stable) nothing runs again: no hole and no cap until the viewer
  // changes section. Reading at call time lets that first delivery — which
  // lands after the refs are attached — perform the first paint.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !band) return;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));

    const apply = (animate: boolean) => {
      const frame = band.frame.current;
      if (!frame) return;
      const fr = frame.getBoundingClientRect();
      const boxes: Box[] = tabs.map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.left - fr.left, w: r.width };
      });
      const next = interpolateBox(boxes, active, progress);
      band.paint(next ? [next] : [], animate);
    };
    applyRef.current = apply;

    // Keep the active section in view — and clear of the fade and chevron on a
    // side that has more — on a SELECTION change only (never wrap; never fight a
    // scroll the viewer is doing by hand). The flag is raised only when the
    // write really moved the list: a clamped no-op fires no scroll event, and a
    // flag left standing would hand the viewer's NEXT hand-scroll the animation.
    // The answer is a rest position (a tab start, 40px in), so the list's
    // mandatory snap has nothing to correct and the tab stays whole. (Tabs come
    // first in items(), so `active` indexes the same tab there.)
    const target = revealTarget(spansOf(list, items(list)), active, list.scrollLeft, list.clientWidth, list.scrollWidth);
    if (target !== null) {
      const before = list.scrollLeft;
      list.scrollLeft = target;
      if (list.scrollLeft !== before) programmatic.current = true;
    }
    // A pager-driven tick (`progress` defined) must not lag a finger.
    apply(progress === undefined);
  }, [active, progress, keySig, band]);

  // Effect C — UNMOUNT ONLY. The Band OUTLIVES this strip: `center` is a prop,
  // and ChatTabBar swaps it from a Sections to the split view's `Panes` when
  // split view turns on, while the Bar (and so the Band around it) stays
  // mounted. Nothing else would then close the hole, so the shade would keep
  // the last selection's gap punched and the cap lit at .85 under a header
  // that measures its own two.
  //
  // Deliberately its OWN effect rather than a cleanup on effect B: effect B
  // re-runs on every selection and pager tick, so its cleanup would fire on
  // each one and snap the hole shut a frame before every slide. This one's
  // only dep is the band handle — stable for the Band's life (a `useMemo` over
  // a `useCallback`) — so it runs exactly once, on the way out.
  //
  // Safe when the WHOLE Bar goes too: `Band.paint` reads its refs at call time
  // and returns early if they are gone, so a paint into a dying Band is a
  // no-op rather than a crash.
  useLayoutEffect(() => () => { band?.paint([], false); }, [band]);

  const close = (e: MouseEvent | KeyboardEvent, key: K) => {
    e.stopPropagation();
    onClose?.(key);
  };

  // A chevron press is a hand-scroll by proxy: no `programmatic` flag, so the
  // hole follows the tabs without lag, exactly as under a finger.
  // It pages to an item START (stripOverflow pageTarget): the next item not
  // shown whole lands flush at the start, so a page never ends inside a tab.
  const page = (dir: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const target = pageTarget(spansOf(list, items(list)), list.scrollLeft, list.clientWidth, list.scrollWidth, dir);
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div ref={wrapRef} className="chrome-sections-wrap">
      <div ref={listRef} className={`chrome-sections chrome-sections-${density}`}>
        <div {...listProps} className="chrome-sections-tabs">
          {tabItems.map((t, i) => (
            <button key={t.key} {...tabProps(i)} className="chrome-tab">
              <span className="chrome-tab-label" data-l={t.label}><span>{t.label}</span></span>
              {t.dot && <span aria-hidden className="chrome-tab-dot" />}
              {t.dot && <span className="sr-only">unread</span>}
              {t.closable && i === active && onClose && (
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${t.label}`}
                  className="chrome-tab-close"
                  onClick={(e) => close(e, t.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(e, t.key); }
                  }}
                >
                  <X size={11} weight="bold" />
                </span>
              )}
            </button>
          ))}
        </div>
        {trail && <div className="chrome-sections-trail">{trail}</div>}
      </div>
      <button type="button" tabIndex={-1} aria-hidden className="chrome-more chrome-more-start" onClick={() => page(-1)}>
        <CaretLeft size={12} weight="bold" />
      </button>
      <button type="button" tabIndex={-1} aria-hidden className="chrome-more chrome-more-end" onClick={() => page(1)}>
        <CaretRight size={12} weight="bold" />
      </button>
    </div>
  );
}
