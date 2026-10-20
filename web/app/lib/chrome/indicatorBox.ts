// Pure indicator-position arithmetic, extracted from Sections.tsx's
// measurement effect so the indicator math can be unit-tested
// without a DOM. Sections measures each rendered tab in BAND space — a rect
// delta, `{ x: tab.rect.left - frame.rect.left, w: tab.rect.width }`, where
// the frame is the enclosing Band's element, not the strip's — into an array
// indexed like `items`, and hands it to this function along with the active
// index and (for the pager) a fractional progress. The single box that
// comes back goes to `Band.paint`, which owns the cap and the shade's mask
// hole and is the only thing that writes them.

export type Box = { x: number; w: number };

/**
 * The box to paint: `boxes[active]` when `progress` is absent (driven
 * by selection). When `progress` is a fractional index (0 … boxes.length−1,
 * from a pane scroller), it's clamped into range and the box is a linear
 * interpolation between its two neighbours. Null when a needed box hasn't
 * been measured yet (a neighbour is null) or `boxes` is empty.
 */
export function interpolateBox(boxes: readonly (Box | null)[], active: number, progress?: number): Box | null {
  if (boxes.length === 0) return null;
  if (progress === undefined) return boxes[active] ?? null;

  const last = boxes.length - 1;
  const p = Math.min(Math.max(progress, 0), last);
  const lo = Math.floor(p);
  const hi = Math.min(lo + 1, last);
  const f = p - lo;
  const a = boxes[lo] ?? null;
  const b = boxes[hi] ?? null;
  if (!a || !b) return a;
  return { x: a.x + (b.x - a.x) * f, w: a.w + (b.w - a.w) * f };
}
