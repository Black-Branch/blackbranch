"use client";

// BarButton — the ONE control that lives in a bar: the ✕, the popout, the back
// arrow, the fold arrow. It lives inside chrome because `check-chrome` seals
// this module, so a bar control written elsewhere would have to hand-roll it.
//
// A component rather than an exported class string on purpose: a class handed
// out as a constant invites a consumer to append to it, which is how spellings
// multiply. This also makes `aria-label` and `title` a single prop, so they
// cannot drift apart.
import type { MouseEventHandler, ReactElement, ReactNode } from "react";

export type BarButtonProps = {
  icon: ReactNode;
  /** Used for BOTH aria-label and title — one prop so they cannot disagree. */
  label: string;
  onClick: () => void;
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
};

export function BarButton({ icon, label, onClick, onMouseDown, display, active }: BarButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      aria-label={label}
      title={label}
      data-active={active ? "" : undefined}
      className={display ? `chrome-bar-btn ${display}` : "chrome-bar-btn"}
    >
      {icon}
    </button>
  );
}
