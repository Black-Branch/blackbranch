"use client";

// BarButton — the ONE control that lives in a bar: the ✕, the popout, the back
// arrow, the fold arrow. It lives inside chrome because `check-chrome` seals
// this module, so a bar control written elsewhere would have to hand-roll it.
//
// A component rather than an exported class string on purpose: a class handed
// out as a constant invites a consumer to append to it, which is how spellings
// multiply. This also makes `aria-label` and `title` a single prop, so they
// cannot drift apart.
import type { MouseEvent, MouseEventHandler, ReactElement, ReactNode, Ref } from "react";

export type BarButtonProps = {
  icon: ReactNode;
  /** Used for BOTH aria-label and title — one prop so they cannot disagree. */
  label: string;
  /** The event is handed over so a control can anchor a menu at its own box. */
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Window's ✕ passes keepFocus: opening/closing must not cost the keyboard. */
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
  /** Tailwind responsive visibility ONLY (the fold arrow is `hidden md:flex`).
   *  Appended, never replacing the shared class. */
  display?: string;
  /** A toggle's on-state (theatre on, compact on, split on): `data-active`,
   *  the shared selected fill. VISUAL ONLY — never aria-pressed, because these
   *  toggles rename themselves with their state ("Fold player" / "Unfold
   *  player"), and a pressed button whose name already says the other action
   *  reads wrong to assistive tech. */
  active?: boolean;
  /** "touch": the button is 40px wide and the bar's full height, the
   *  thumb-sized target Discord gives header icons; the icon and its hover/on
   *  pill keep their 26px look (chrome.css .chrome-bar-btn--touch). */
  size?: "touch";
  /** A control that opens a menu or panel says so: aria-expanded. */
  expanded?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

export function BarButton({ icon, label, onClick, onMouseDown, display, active, size, expanded, ref }: BarButtonProps): ReactElement {
  const base = size === "touch" ? "chrome-bar-btn chrome-bar-btn--touch" : "chrome-bar-btn";
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      data-active={active ? "" : undefined}
      className={display ? `${base} ${display}` : base}
    >
      {icon}
    </button>
  );
}
