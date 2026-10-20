// web/app/lib/chrome/tabListKeys.ts
// The WAI-ARIA "tabs" keyboard model, as pure functions so it can be tested
// without a DOM and shared by every skin in app/components/chrome/. Arrow keys
// move focus AND selection (selection follows focus), wrapping at the ends;
// Home/End jump. Anything else returns null so the caller leaves the event
// alone — Tab must keep leaving the strip (uxpatterns.dev anti-pattern #1).

export type Orientation = "horizontal" | "vertical";

/**
 * Index reached from `current` by `key`, or null when the key is not one the tab list owns.
 */
export function moveIndex(
  current: number,
  key: string,
  count: number,
  orientation: Orientation = "horizontal",
): number | null {
  if (count <= 0) return null;
  const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
  const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
  switch (key) {
    case next: return (current + 1) % count;
    case prev: return (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

/**
 * The selected index for `value` among `keys`; 0 when absent, so exactly one tab is always selected.
 */
export function activeIndex(keys: readonly string[], value: string): number {
  const i = keys.indexOf(value);
  return i >= 0 ? i : 0;
}
