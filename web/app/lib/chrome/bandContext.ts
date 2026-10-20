// web/app/lib/chrome/bandContext.ts
// The band (shade + cap) belongs to the CONTAINER — a Bar or a Window band — so
// it can span the whole strip while the Sections inside it
// reports where the hole goes. This is the handshake, and it is deliberately
// one-way: the Band publishes its own frame, to measure against, plus a
// `paint` callback. A consumer measures in that frame's space and hands back a
// box list — one from a Sections, a pair from the split view's Panes; the shade
// and the caps stay private to Band.tsx, so the only component that writes
// those elements is the one that renders them.
// No provider → Sections renders its own Band.
import { createContext, type RefObject } from "react";
import type { Box } from "./indicatorBox.ts";

export type BandHandle = {
  /** The band's own box — Sections measures its tabs against this rect. */
  frame: RefObject<HTMLDivElement | null>;
  /** Paint the hole(s) + cap(s): index 0 → --ind-x/--ind-w + cap A, index 1 →
   *  --ind-x2/--ind-w2 + cap B; `[]` = nothing selected (holes closed, caps
   *  out). Exactly two are paintable — the mask has two hole layers; a third
   *  box is ignored until a consumer needs it and adds its layer. `animate`
   *  false snaps (scroll/resize follow-ups, pager ticks). Slots are ABSOLUTE,
   *  not per-consumer: every paint writes both slots, so a Band supports
   *  exactly ONE painting consumer at a time — a second would clobber the
   *  first. */
  paint: (boxes: readonly Box[], animate: boolean) => void;
};

export const BandContext = createContext<BandHandle | null>(null);
