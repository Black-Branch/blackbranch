import type { MatrixEvent } from "matrix-js-sdk";

// Discord-style consecutive grouping, shared by the main timeline and the
// thread panel: same sender, within the window, the current message isn't a
// reply (replies always start a fresh block with their context), and the same
// local calendar day (a date divider sits between days, so a group can't
// straddle one).
//
// GROUP_WINDOW_MS and sameDay are module-private: check-orphans excludes a
// symbol's own file from its reference count, so a same-file caller (both
// functions below) doesn't count as wiring it up, and only startsNewDay and
// isContinuation have a consumer outside this file (Timeline.tsx,
// ThreadPanel.tsx).
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Same local calendar day (what the reader's clock calls "today"). */
function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** A date divider goes above `ev` — the first row, or a day change. */
export function startsNewDay(prev: MatrixEvent | undefined, ev: MatrixEvent): boolean {
  return !prev || !sameDay(prev.getTs(), ev.getTs());
}

export function isContinuation(prev: MatrixEvent | undefined, ev: MatrixEvent): boolean {
  if (!prev) return false;
  if (prev.getSender() !== ev.getSender()) return false;
  if (ev.getTs() - prev.getTs() > GROUP_WINDOW_MS) return false;
  if (!sameDay(prev.getTs(), ev.getTs())) return false;
  const rel = (ev.getContent() as Record<string, unknown>)["m.relates_to"] as
    | Record<string, unknown>
    | undefined;
  if (rel?.["m.in_reply_to"]) return false;
  return true;
}
