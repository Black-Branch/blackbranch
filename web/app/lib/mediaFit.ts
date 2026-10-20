// The box an inline image or video sits in.
//
// Discord's rule: fit the source's aspect inside a fixed box and never enlarge
// it past its own pixels. 550×350 is Discord's desktop attachment box as of
// its 2023 media update — assumed, not measured in a logged-in client; if a
// measurement disagrees, these two constants are the only place to change.

export const MEDIA_BOX_W = 550;
// Not exported: its only reader outside a test is the default parameter below,
// and check-orphans does not count a test import as a caller.
const MEDIA_BOX_H = 350;

export type MediaBox = {
  /** CSS px to set as the element's width. */
  width: number;
  height: number;
  /** The SOURCE aspect for `aspect-ratio`, so a narrower screen shrinks the
   *  width and the browser keeps the exact proportion (no rounding drift). */
  aspect: string;
};

/** The largest size with the source's aspect that fits inside `maxW × maxH`,
 *  capped at the source size. `null` when either dimension is unusable (event
 *  `info.w/h` is user-supplied and may be missing, a string, or zero). */
export function fitMediaBox(w: unknown, h: unknown, maxW = MEDIA_BOX_W, maxH = MEDIA_BOX_H): MediaBox | null {
  const sw = Number(w);
  const sh = Number(h);
  if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) return null;
  if (!Number.isFinite(maxW) || !Number.isFinite(maxH) || maxW <= 0 || maxH <= 0) return null;
  const scale = Math.min(1, maxW / sw, maxH / sh);
  return { width: Math.round(sw * scale), height: Math.round(sh * scale), aspect: `${sw} / ${sh}` };
}
