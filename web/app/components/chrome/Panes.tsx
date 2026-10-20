// web/app/components/chrome/Panes.tsx
"use client";

// The split header: one pane-header button per open pane, each with the
// Console hole cut over it, the split line in the header aligned to the real
// divider. Deliberately NOT a tab list — a tablist cannot have two selected
// tabs, and both panes are open — so this is a role="group" of two buttons;
// clicking a pane header EXPANDS that pane (the affordance is the hover/
// focus-revealed ⤢, .chrome-pane-expand).
//
// Geometry follows Sections' pattern exactly: the Band frame is read INSIDE
// `apply` at call time (an ancestor's host ref attaches only after this
// component's layout effects — the ResizeObserver's initial delivery performs
// the first paint), boxes are rect deltas in band space, and the unmount-only
// cleanup closes both holes because the Band outlives the split state.
//
// The first cell's width is the live column's width in ASIDE space
// (`firstWidth`, e.g. var(--live-col-w)); the band spans the WHOLE bar,
// leading slot included, so it is the GROUP that starts after that slot —
// the cell subtracts the group's measured offset from the frame
// (`--chrome-panes-offset`) to keep the header's split line on the
// real divider — including mid-drag, because the divider writes the variable
// and the cells' ResizeObserver repaints the holes.
import { useContext, useLayoutEffect, useRef } from "react";
import { ArrowsOutSimple } from "@phosphor-icons/react/dist/ssr";
import { BandContext } from "@/app/lib/chrome/bandContext";
import type { Box } from "@/app/lib/chrome/indicatorBox";

export type PaneDef<K extends string> = {
  key: K;
  label: string;
  dot?: boolean;
  /** The button's title — clicking a pane header EXPANDS that pane. */
  expandTitle: string;
};

/** A CSS length the first cell can bear: a px/percent literal, a var() or a
 *  calc(). Narrowed so the raw-number mistake (`firstWidth={liveColW}`) fails
 *  the compile instead of painting a unitless width (split-band final review,
 *  parked item). */
type PaneWidth = `${number}px` | `${number}%` | `var(--${string})` | `calc(${string})`;

export type PanesProps<K extends string> = {
  panes: readonly [PaneDef<K>, PaneDef<K>];
  /** Aside-space width of the FIRST pane (a CSS length); the second takes the rest. */
  firstWidth: PaneWidth;
  onExpand: (key: K) => void;
  label: string;
};

export function Panes<K extends string>({ panes, firstWidth, onExpand, label }: PanesProps<K>) {
  const band = useContext(BandContext);
  const groupRef = useRef<HTMLDivElement>(null);
  // Re-measure when the SET of pane keys changes, not when the tuple's identity
  // does — a consumer writing the pair inline (ChatTabBar does) hands a new
  // array every render. A single string keeps the dep statically checkable;
  // `panes[0].key` is a computed member expression, which exhaustive-deps
  // refuses to check at all.
  const keySig = `${panes[0].key}|${panes[1].key}`;

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group || !band) return;
    const buttons = Array.from(group.querySelectorAll<HTMLElement>(".chrome-pane > button"));

    const apply = (animate: boolean) => {
      const frame = band.frame.current;
      if (!frame) return;
      const fr = frame.getBoundingClientRect();
      // The cells position against the aside; the band frame starts at the
      // bar's LEFT edge (the leading slot is inside it) and the GROUP starts
      // after that slot — publish the difference so firstWidth can subtract it.
      group.style.setProperty("--chrome-panes-offset", `${Math.max(0, group.getBoundingClientRect().left - fr.left)}px`);
      const boxes: Box[] = buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.left - fr.left, w: r.width };
      });
      band.paint(boxes, animate);
    };

    apply(false);
    const ro = new ResizeObserver(() => apply(false));
    ro.observe(group);
    for (const el of Array.from(group.children)) ro.observe(el);
    for (const el of buttons) ro.observe(el);
    return () => ro.disconnect();
  }, [band, keySig]);

  // UNMOUNT ONLY — the Band outlives the split state (same reasoning as
  // Sections' effect C): unsplitting must close both holes.
  useLayoutEffect(() => () => { band?.paint([], false); }, [band]);

  return (
    <div ref={groupRef} role="group" aria-label={label} className="chrome-panes">
      {panes.map((p, i) => (
        <div key={p.key} className="chrome-pane" style={i === 0 ? { width: `calc(${firstWidth} - var(--chrome-panes-offset, 0px))` } : undefined}>
          <button type="button" data-open title={p.expandTitle} onClick={() => onExpand(p.key)} className="chrome-tab">
            <span className="chrome-tab-label" data-l={p.label}><span>{p.label}</span></span>
            {p.dot && <span aria-hidden className="chrome-tab-dot" />}
            {p.dot && <span className="sr-only">unread</span>}
            <ArrowsOutSimple size={11} weight="bold" className="chrome-pane-expand" />
          </button>
        </div>
      ))}
    </div>
  );
}
