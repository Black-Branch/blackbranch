// Capacity-transition rule for the Matrix UnifiedLayout — what must close when
// the panel's width class changes.
//
// Sibling to matrixVisibility.ts: that one answers "given the current state,
// what renders?"; this one answers "the mode just changed, what has to give?".
// It was an inline useEffect, which made two subtle rules invisible to review:
//
//   1. Mode 3 opens the directory ONLY on ENTERING mode 3. Applying it on every
//      render re-forces the panel open, so the close button can never win — the
//      user clicks X, the effect immediately reopens it. That one-shot condition
//      is the whole reason the effect tracked a previous-mode ref.
//   2. Mode 2 fits the timeline plus ONE side panel. If both are open when the
//      panel narrows into mode 2, the tie is broken by which side the user
//      touched LAST — the least surprising panel to lose is the one they have
//      not interacted with.
//
// Pure so both rules can be tested; the component keeps the refs and setters.

/** Which side panel the user interacted with most recently. */
export type LastSide = "dir" | "mem" | null;

export interface CapacityInput {
  /** The width class we are entering (1 | 2 | 3). */
  mode: number;
  /**
   * The width class we were in. The caller seeds its ref with `0` before the
   * first transition, and `null` is accepted for the same meaning — what the
   * rule actually asks is "were we already in mode 3?", so any non-3 value
   * (0, null, 1, 2) counts as "not previously wide" and is treated alike.
   */
  prevMode: number | null;
  directoryOpen: boolean;
  membersOpen: boolean;
  lastSide: LastSide;
}

/**
 * What to change, as a sparse patch. An absent key means "leave it alone" —
 * deliberately NOT `false`, so the caller cannot accidentally close a panel the
 * rule had no opinion about.
 */
export interface CapacityPatch {
  directoryOpen?: boolean;
  membersOpen?: boolean;
}

export function resolveCapacityChange({
  mode,
  prevMode,
  directoryOpen,
  membersOpen,
  lastSide,
}: CapacityInput): CapacityPatch {
  if (mode === 3) {
    // One-shot on ENTRY only. Re-applying every render would make the directory
    // impossible to close (see rule 1 above).
    return prevMode !== 3 ? { directoryOpen: true } : {};
  }

  if (mode === 2 && directoryOpen && membersOpen) {
    // Over capacity: keep whichever side was touched most recently.
    return lastSide === "mem" ? { directoryOpen: false } : { membersOpen: false };
  }

  // Mode 1 closes nothing here — resolveVisibility already shows exactly one
  // panel at a time, so the open flags stay as the user left them and are
  // restored intact when the panel widens again.
  return {};
}
