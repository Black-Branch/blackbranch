// One size and one skin for every control in a composer row.
//
// WHY THIS EXISTS. Controls that each bring their own sizing system (ems,
// fixed `h-7 w-7`, `self-stretch` + padding) render at different diameters,
// and the row reads as a pile of separate widgets rather than one designed
// strip. So the size lives here, once, and every control uses it.
//
// It is derived from `--chat-font-size`, not a fixed pixel value. The typing
// field grows with the user's chat text size, and a control pinned to `28px`
// silently stops matching it at any setting but the default.

/**
 * Diameter of every circular composer control — and the height the typing field
 * collapses to.
 *
 * DERIVED, not a measured multiplier. `--composer-ctl` in globals.css is built
 * from exactly the terms that give the field its single-line height (line box +
 * its own vertical padding + border), so a control can never be a few pixels
 * off the field it sits beside. An eyeballed `chatFontCalc(1.8)` would run ~6px
 * short at the default chat size.
 */
export const CTL_SIZE = "var(--composer-ctl)";

/** Icon size inside one. Deliberately ~half the control, so the glyph sits in a
 *  ring of space instead of filling the circle edge to edge. */
export const CTL_ICON = "0.95em";

export const ctlBox = { width: CTL_SIZE, height: CTL_SIZE } as const;

/**
 * The shared skin. Secondary controls are OUTLINED, never filled — exactly one
 * control in the row is filled (send), which is what makes it read as the
 * primary action rather than one button among five.
 *
 * `active` is for a control that is currently doing something (menu open, a
 * destination pinned, a cheer armed) — it gains a surface so state is visible
 * at rest. That matters more than it sounds: on touch there is no hover, so a
 * hover-only affordance is invisible on exactly the devices this row is hardest
 * to use on.
 */
export function ctlClass(active = false): string {
  return [
    "tap-press shrink-0 inline-flex items-center justify-center rounded-full border",
    "transition-colors disabled:opacity-40",
    active
      ? "bg-surface-3 border-edge-strong text-strong"
      : "bg-surface-2 border-edge text-secondary hover:bg-surface-3 hover:text-body",
  ].join(" ");
}
