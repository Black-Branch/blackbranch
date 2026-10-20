// Shared sizing for the floating user card so its two call sites — the live-chat
// sidebar and the OBS overlay — clamp against the same dimensions. The vertical
// above/below decision stays local to each (the overlay and the sidebar anchor
// differently); only the size + horizontal clamp are shared here.
export const USER_CARD_W = 288;
export const USER_CARD_H = 340;

/** Clamp a coordinate so a box of `size` stays inside `viewport` (default 8px margin).
 *  The one popover/tooltip clamp idiom — was hand-rolled at six call sites. */
export function clampToViewport(pos: number, size: number, viewport: number, margin = 8): number {
  return Math.max(margin, Math.min(pos, viewport - size - margin));
}

/** Clamp the card's left edge so it stays within the viewport (default 8px margin). */
export function clampCardLeft(left: number, viewportW: number, margin = 8): number {
  return clampToViewport(left, USER_CARD_W, viewportW, margin);
}
