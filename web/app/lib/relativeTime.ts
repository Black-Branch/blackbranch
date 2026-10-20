// Plain-words time labels for the Home tab ("ended 3h ago · ran 8h 55m").
// Pure, so the widgets can be rendered in a test with a fixed clock.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "just now" under a minute, then the largest unit that fits. "" for junk. */
export function agoLabel(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, nowMs - t);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`;
  if (d < WEEK) return `${Math.floor(d / DAY)}d ago`;
  return `${Math.floor(d / WEEK)}w ago`;
}

/** "8h 55m" / "42m"; never negative. */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
