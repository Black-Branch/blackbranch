// The part of the layout viewport the user can actually SEE.
//
// WHY THIS EXISTS: every floating thing in chat clamps itself with
// `window.innerWidth/innerHeight`, which is the LAYOUT viewport — it does not
// know about the soft keyboard or a pinch-zoom pan. Since a long-press keeps
// the keyboard up, a long-press menu on a bottom-third row would clamp into
// the region the keyboard is sitting on and land behind it.
//
// `visualViewport` is the browser's own answer: `height` excludes the keyboard,
// and `offsetTop/offsetLeft` say where the visible region currently sits inside
// the layout viewport. Both numbers are in the same coordinate space a
// `position: fixed` box is placed in, so callers can clamp directly against
// them.
//
// The two viewports COINCIDE on this app's primary target: the meta is
// `interactive-widget=resizes-content`, which shrinks the layout viewport too,
// so `offsetTop` is 0 and `height` equals `innerHeight` — this changes nothing
// there. It matters where the browser ignores that meta (iOS Safari always
// resizes the visual viewport only) and while pinch-zoomed anywhere.

export type ViewportBox = { top: number; left: number; width: number; height: number };

export function visibleViewport(): ViewportBox {
  // Zeros on the server. Every caller is a portal that returns null without a
  // `document`, so the numbers are never used to place anything — this exists
  // so a render-phase call does not throw during SSR.
  if (typeof window === "undefined") return { top: 0, left: 0, width: 0, height: 0 };
  const vv = window.visualViewport;
  if (!vv) return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  return { top: vv.offsetTop, left: vv.offsetLeft, width: vv.width, height: vv.height };
}

/**
 * Clamp a fixed-positioned box of `size` into a visible span, honouring the
 * span's origin. `clampToViewport` assumes the viewport starts at 0; this is
 * the same idiom for a span that starts somewhere else.
 */
export function clampIntoSpan(pos: number, size: number, origin: number, extent: number, margin = 8): number {
  return origin + Math.max(margin, Math.min(pos - origin, extent - size - margin));
}
