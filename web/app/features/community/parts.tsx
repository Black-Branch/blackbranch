// Unread indicator dot — null when nothing is unread, rose for highlights
// (mentions), accent-blue otherwise. Shared by the channel rows (small inline
// dot) and the spaces rail (corner badge); the caller passes size/position via
// `className`.
export function UnreadDot({
  total,
  highlight,
  className = "",
  counts = false,
}: {
  total: number;
  highlight: number;
  className?: string;
  /** Community › Unread channels › Counts: a number instead of the dot —
   *  the mention count in rose when there is one, else the unread count. The
   *  caller's className (a dot's size) does not apply to the pill. */
  counts?: boolean;
}) {
  if (total === 0) return null;
  if (counts) {
    const n = highlight > 0 ? highlight : total;
    return (
      <span data-unread-dot={highlight > 0 ? undefined : ""}
        className={`shrink-0 min-w-4 h-4 px-1 rounded-full text-3xs font-semibold leading-4 text-center tabular-nums ${highlight > 0 ? "bg-rose-500 text-strong" : "bg-accent text-on-accent"}`}>
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
