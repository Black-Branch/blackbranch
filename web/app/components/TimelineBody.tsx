"use client";

import type { ReactNode } from "react";
import EmptyState from "./EmptyState";
import { TimelineSkeleton } from "./TimelineSkeleton";

// The ONE component that draws a message area — the community timeline's and the DM window's
// (client polish Task 11; dm-crypto-research D, k's item 12: opening a DM ran five message-area
// states in 235 ms with three layout shifts). It shows exactly one of:
//   - the skeleton, while `phase` is "loading" (useRoomTimeline owns the phase);
//   - "No messages yet", once ready with no rows (the beginning reached, or loading stopped at its
//     ceiling or on a failed page — never a blank area);
//   - the rows.
// While loading the rows are already laid out UNDER the skeleton, invisible: the auto-fill
// measures them, and the first row is where it will stay when the skeleton goes — the area
// changes once (skeleton → rows) and nothing moves.
// The top slot is one box of one fixed height: "Loading earlier messages…", then at the start of
// the room the caller's `topSlot` (the DM list's "Earlier conversation", Task 20) or "Beginning of
// conversation", or nothing.
// It sits inside the caller's scroller content (the scroll engine's contentRef), which is a
// column at least the scroller's height: the area grows to it, so the skeleton stands on the
// scroller's bottom edge even before there is a row.

export function TimelineBody({ phase, count, hitStart, paginating, rows, emptyText, topSlot }: {
  phase: "loading" | "ready";
  /** How many rows `rows` holds. */
  count: number;
  hitStart: boolean;
  paginating: boolean;
  rows: ReactNode;
  emptyText: string;
  /** Shown at the start of the room instead of "Beginning of conversation" (an older room before it). */
  topSlot?: ReactNode;
}) {
  const loading = phase === "loading";
  const top = loading
    ? null
    : paginating
      ? "Loading earlier messages…"
      : hitStart
        ? (topSlot ?? (count > 0 ? "Beginning of conversation" : null))
        : null;
  return (
    <div className="relative flex grow flex-col" data-timeline-phase={phase} aria-busy={loading || undefined}>
      <div data-timeline-top="" className="h-6 shrink-0 flex items-center justify-center text-muted text-3xs">{top}</div>
      {!loading && count === 0 && <EmptyState className="text-center mt-8">{emptyText}</EmptyState>}
      <div data-timeline-rows="" className={`flex flex-col${loading ? " invisible" : ""}`} aria-hidden={loading || undefined}>
        {rows}
      </div>
      {loading && <TimelineSkeleton />}
    </div>
  );
}
