// Pure geometry clamp for the chrome Window's floating variant. Kept
// dependency-free on purpose — no localStorage/browser globals — so it's
// testable under node --test with no DOM. The load/save halves that DO touch
// localStorage live in panelGeometryStore.ts (the chatIdentity/homeserverTrust
// precedent: keep the pure predicate testable, isolate the browser-only I/O).

export type Geom = { x: number; y: number; w: number; h: number };

/** Persisted shape: geometry plus whether the height is content-fit. `fit` is
 *  absent on rows saved before content-fit existed (treated as an explicit
 *  height — those users had already been given one) and `false` once the user
 *  resizes; only a fit-height panel that has never been height-resized saves
 *  `fit: true`. */
export type StoredGeom = Geom & { fit?: boolean };

/** Parse a persisted geometry JSON string. Validates every field is a finite
 *  number so a hand-edited or stale-shape value in localStorage can't hand the
 *  caller NaN/undefined to render with; a non-boolean `fit` is dropped rather
 *  than poisoning the row. Pure so it's testable under node --test — the
 *  localStorage read lives in panelGeometryStore.ts. */
export function parseGeom(raw: string | null): StoredGeom | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<StoredGeom> | null;
    if (!g) return null;
    if (![g.x, g.y, g.w, g.h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const { x, y, w, h } = g as Geom;
    return typeof g.fit === "boolean" ? { x, y, w, h, fit: g.fit } : { x, y, w, h };
  } catch {
    return null;
  }
}

/** Content-fit max-height CSS for a floating panel at viewport offset `topPx`:
 *  height follows the content, clamped to 82dvh AND to what actually fits
 *  below the panel's top edge — so a panel dragged low can never grow past the
 *  viewport bottom. One rule for every panel, since there is now exactly one
 *  shell (Window) and every surface goes through it. */
export function fitMaxHeight(topPx: number): string {
  return `min(82dvh, calc(100dvh - ${Math.round(topPx)}px - 8px))`;
}

/** Clamp a panel's box into the viewport, sizing first (against min/max, itself
 *  capped to the viewport) and then position (against the clamped size).
 *
 *  `effectiveH` is the panel's ACTUALLY RENDERED height, and matters only for
 *  content-fit panels, where `g.h` is a nominal placeholder the panel is not
 *  currently using. Without it the vertical bound is computed against that
 *  phantom height, so the panel stops short of the viewport bottom by
 *  `g.h - renderedH` (e.g. 68px of dead space under a profile card whose
 *  nominal h is 560 but renders at 493). The returned
 *  `h` is still the clamped NOMINAL height — `effectiveH` moves the position
 *  bound only, never what gets persisted, or a content-fit panel would save a
 *  height it never chose. */
export function clampGeom(
  g: Geom,
  vw: number,
  vh: number,
  min: { w: number; h: number },
  max: { w: number; h: number },
  effectiveH?: number
): Geom {
  const w = Math.min(Math.max(g.w, min.w), Math.min(max.w, vw));
  const h = Math.min(Math.max(g.h, min.h), Math.min(max.h, vh));
  const boundH =
    typeof effectiveH === "number" && Number.isFinite(effectiveH) && effectiveH > 0
      ? Math.min(effectiveH, vh)
      : h;
  const x = Math.min(Math.max(g.x, 0), vw - w);
  const y = Math.min(Math.max(g.y, 0), vh - boundH);
  return { x, y, w, h };
}

/** Render-time page-floor fit: width
 *  grows to meet `minWidth` WITHOUT entering the saved box — only user
 *  gestures persist. x shifts only when the grown box would leave the
 *  viewport (grow in place, don't recentre: a drag applies deltas to the
 *  underlying box, and an x that tracks it 1:1 is what keeps the card under
 *  the pointer). Returns `box` itself when nothing grows, so render memo
 *  comparisons stay cheap. */
export function displayBox(box: Geom, minWidth: number | undefined, vw: number): Geom {
  const w = Math.min(Math.max(box.w, minWidth ?? 0), Math.max(vw - 16, 1));
  if (w === box.w) return box;
  const x = box.x + w <= vw - 8 ? box.x : Math.max(8, vw - 8 - w);
  return { ...box, w, x };
}

// There are no mobile-sheet helpers: phones get the same centered, draggable,
// resizable card every other viewport gets — see Window's header. Don't bring
// a height-only mobile mode back.
