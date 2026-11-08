import { useSetting } from "@/app/lib/useSetting";
import { DEFAULTS, UNREAD_MODES, type UnreadMode } from "@/app/lib/settingsRegistry";

/** Community › Channel list › Unread channels, read once per list (rows take it as a prop). */
export function useUnreadMode(): UnreadMode {
  const raw = useSetting("chatStyle_mxUnread");
  // Nothing stored (or junk) = the registry default: one source, never a second literal here.
  return UNREAD_MODES.find((m) => m === raw) ?? DEFAULTS.mxUnread;
}

/** Whether UnreadDot draws a number (the pill) rather than a dot. */
function unreadIsPill(mode: UnreadMode, total: number, highlight: number): boolean {
  return total > 0 && (mode === "counts" || (mode === "mentions" && highlight > 0));
}

// Unread indicator — null when nothing is unread, rose for highlights
// (mentions), accent-blue otherwise. Shared by the channel rows (small inline
// dot) and the spaces rail (corner badge); the caller passes the dot's
// size/position via `className`, the pill's position via `pillClassName`.
export function UnreadDot({
  total,
  highlight,
  mode = "dots",
  className = "",
  pillClassName = "",
}: {
  total: number;
  highlight: number;
  /** dots: always a dot. mentions: the mention count in rose, a plain unread stays a dot.
   *  counts: a number — the mention count in rose when there is one, else the unread count. */
  mode?: UnreadMode;
  className?: string;
  pillClassName?: string;
}) {
  if (total === 0) return null;
  if (unreadIsPill(mode, total, highlight)) {
    const n = highlight > 0 ? highlight : total;
    return (
      <span data-unread-dot={highlight > 0 ? undefined : ""}
        className={`shrink-0 min-w-4 h-4 px-1 rounded-full text-3xs font-semibold leading-4 text-center tabular-nums ${highlight > 0 ? "bg-rose-500 text-strong" : "bg-accent text-on-accent"} ${pillClassName}`}>
        {n > 99 ? "99+" : n}
      </span>
    );
  }
  return (
    // The blue dot carries the Behavior › Unread dots hook; the red mention
    // count never does — it is about you, so hiding unread dots never hides it.
    <span data-unread-dot={highlight > 0 ? undefined : ""} className={`rounded-full ${highlight > 0 ? "bg-rose-500" : "bg-accent"} ${className}`} />
  );
}
