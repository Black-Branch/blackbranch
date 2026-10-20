// SVG path math for the Stream tab's hand-rolled charts (ported from the household site's
// lib/chartPath.ts): pure, so the scaling is pinned by node --test without rendering anything.
// Coordinates round to one decimal — a path string is the payload, and four digits buy nothing.

export type XY = readonly [number, number];

const r1 = (n: number): number => Math.round(n * 10) / 10;

export function linePath(pts: readonly XY[]): string {
  return pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${r1(x)},${r1(y)}`).join(" ");
}

/** The line, closed down to `baselineY`: a filled area. */
export function areaPath(pts: readonly XY[], baselineY: number): string {
  if (pts.length === 0) return "";
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${linePath(pts)} L${r1(last[0])},${r1(baselineY)} L${r1(first[0])},${r1(baselineY)} Z`;
}

/** A step line: flat until each point, then straight up to it (a running total). */
export function stepPath(pts: readonly XY[]): string {
  if (pts.length === 0) return "";
  const out = [`M${r1(pts[0]![0])},${r1(pts[0]![1])}`];
  for (let i = 1; i < pts.length; i++) {
    out.push(`L${r1(pts[i]![0])},${r1(pts[i - 1]![1])}`, `L${r1(pts[i]![0])},${r1(pts[i]![1])}`);
  }
  return out.join(" ");
}

/** A scale from a [lo, hi] domain onto a [a, b] range; a zero-width domain maps to `a`. */
export function scale(lo: number, hi: number, a: number, b: number): (v: number) => number {
  const span = hi - lo;
  return (v) => (span === 0 ? a : a + ((v - lo) / span) * (b - a));
}
