"use client";

// A composer popover that no ancestor can clip.
//
// The composer sits inside a chat column that is `overflow: hidden`, so a menu
// positioned inside it that is taller than the space above the field is not
// scrolled off — it is CUT OFF, top first, which is where its search box lives.
// On a phone with the keyboard up there is almost no space above the field.
//
// Measuring the available height and shrinking to fit is only a workaround for
// being in the wrong box, and it depends on catching every event that changes
// the geometry (it fails when the picker opens just before the keyboard
// animates in).
//
// A portal is the actual fix: rendered at <body>, positioned `fixed` against the
// trigger's real rect, so no ancestor's overflow, transform or stacking context
// applies. Position and height are recomputed against `visualViewport` — the
// keyboard-aware box — every frame that matters.

import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

type Props = {
  /** The control this hangs off. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * The portal root, handed back to the caller.
   *
   * Needed because a portal breaks `useOutsideClick`. That hook asks
   * `ref.current.contains(e.target)`, which walks the DOM — and this content is
   * a child of <body>, NOT of whatever wrapper the caller put its ref on, no
   * matter how it nests in the React tree. Without a ref that is genuinely
   * INSIDE the portal, every press on the menu reads as a press outside it.
   * `EmotePicker` and `StickerBoostPopover` already avoid this by holding a ref
   * to their own inner content; this prop is for callers whose children are the
   * rows themselves.
   */
  innerRef?: RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
  /** Natural width; clamped to the viewport on narrow screens. */
  width?: number;
  /** Tallest it may ever be — it shrinks below this to fit. */
  maxHeight?: number;
  /**
   * Which popover edge hugs the trigger. "right" (default) is the historical
   * behaviour — right edges aligned, menu grows leftward (right-side triggers:
   * tools, emotes). "left" aligns left edges so the panel grows RIGHTWARD —
   * for left-side triggers like the send-to button, whose support bubble
   * would otherwise hang off the chat column's left edge.
   */
  align?: "right" | "left";
  /**
   * Anchor the popover's BOTTOM above the whole composer bar (the trigger's
   * positioned ancestor) instead of the trigger itself. The send-to button
   * sits on the bar's BOTTOM row, so a multi-line draft would grow the bar UP
   * through a trigger-anchored panel.
   */
  barTop?: boolean;
  /**
   * Re-place every frame the anchor's geometry actually changes. Event-based
   * repositioning missed real sources twice on device (composer autogrow via
   * one path, keyboard-close via another — the composer moves on the lifted
   * panel's OWN transform transition, `useKeyboardLift`, which finishes with NO
   * viewport event at settle). One rect-compare per frame while OPEN is ground
   * truth and costs nothing user-visible.
   */
  track?: boolean;
  className?: string;
};

const GAP = 8;      // breathing room between the popover and its trigger
const MARGIN = 8;   // and between the popover and the viewport edges

export function ComposerPopover({
  anchorRef, innerRef, children, width = 280, maxHeight = 320, align = "right",
  barTop = false, track = false, className = "",
}: Props) {
  const [box, setBox] = useState<{ left: number; top: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const a = anchorRef.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      // The vertical anchor: the trigger, or (barTop) the whole composer bar —
      // the trigger's positioned ancestor. The send-to button lives on the
      // bar's BOTTOM row, so a multi-line draft grew the bar up THROUGH a
      // trigger-anchored panel while the trigger itself never moved.
      const bar = barTop ? (a.offsetParent as HTMLElement | null) : null;
      const topEdge = bar ? bar.getBoundingClientRect().top : r.top;
      const vv = window.visualViewport;
      // The KEYBOARD-AWARE viewport, not the layout one. With the keyboard up
      // these differ by exactly the keyboard's height, which is the whole
      // problem being solved.
      const vTop = vv?.offsetTop ?? 0;
      const vLeft = vv?.offsetLeft ?? 0;
      const vW = vv?.width ?? window.innerWidth;

      const w = Math.min(width, vW - MARGIN * 2);
      // Edge-aligned to the trigger (see `align`), then pulled inside the viewport.
      let left = align === "left" ? r.left : r.right - w;
      left = Math.min(Math.max(left, vLeft + MARGIN), vLeft + vW - w - MARGIN);

      // Positioned by TOP in client coordinates, then pulled up by its own
      // height with translateY(-100%). `getBoundingClientRect` and `position:
      // fixed` share that coordinate space, so no `innerHeight` arithmetic is
      // involved — which matters because on iOS `innerHeight` keeps counting the
      // area behind the keyboard and would place this underneath it.
      // Anchoring by the bottom edge this way also means a SHORT menu (the 3-row
      // tools list) sits snug against its trigger while a TALL one (the emote
      // grid) grows upward, with no per-popover special-casing.
      const room = (topEdge - GAP) - (vTop + MARGIN);
      const h = Math.max(140, Math.min(maxHeight, Math.floor(room)));

      setBox({ left, top: topEdge - GAP, w, h });
    }

    place();
    const vv = window.visualViewport;
    // `scroll` matters as much as `resize`: iOS scrolls the visual viewport when
    // the keyboard opens rather than resizing the layout one.
    vv?.addEventListener("resize", place);
    vv?.addEventListener("scroll", place);
    window.addEventListener("resize", place);
    window.addEventListener("orientationchange", place);
    // The composer bar can also RESIZE with no viewport event (field autogrow).
    const grower = anchorRef.current?.offsetParent ?? document.body;
    const ro = new ResizeObserver(place);
    ro.observe(grower);
    // Ground-truth tracking (opt-in): events above missed real movement
    // sources twice on device — the bar settles after keyboard close on the
    // lifted panel's own transform transition (`useKeyboardLift`), with nothing
    // left to fire. One rect compare per frame while open re-places only when
    // geometry changed.
    let raf = 0;
    if (track) {
      let lastKey = "";
      const tick = () => {
        const a = anchorRef.current;
        // Hidden tab: keep the loop alive but do no layout reads (the
        // perf-mode discipline — no work the compositor can't show).
        if (a && !document.hidden) {
          const r = a.getBoundingClientRect();
          const key = `${r.left},${r.top},${r.width},${r.height}`;
          if (key !== lastKey) { lastKey = key; place(); }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    return () => {
      vv?.removeEventListener("resize", place);
      vv?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [anchorRef, width, maxHeight, align, barTop, track]);

  if (typeof document === "undefined") return null;

  // ALWAYS RENDER THE CHILDREN — never `!box && return null`. Returning null
  // withholds them for one commit, so a child's mount effect runs against a
  // ref that is still `null` and fails SILENTLY: the picker's
  // `searchRef.current?.focus()` no-ops (focus stays on <body>), and
  // SupportPanel's scroll-to-newest no-ops (a reopened thread sits at the
  // OLDEST line).
  //
  // Only the discrete-event path is affected: mounted at the root, React
  // flushes the layout-effect re-render before the passive effects and the ref
  // is there. Opened from a click handler the order inverts, and every real
  // open is a click.
  //
  // `opacity`, NOT `visibility`/`display` — a hidden node CANNOT TAKE FOCUS,
  // so hiding it that way fixes the ref and leaves focus broken while
  // looking correct. `place()` runs in a layout effect, i.e. before paint, so
  // this state is laid out and measurable but never reaches the screen.
  const placement = box
    ? { left: box.left, top: box.top, width: box.w, maxHeight: box.h }
    : { left: 0, top: 0, width, maxHeight, opacity: 0, pointerEvents: "none" as const };

  return createPortal(
    <div
      ref={innerRef}
      className={`fixed glass rounded-xl overflow-hidden flex flex-col ${className}`}
      // --z-float is the scale's "floating menus/cards over the main layout"
      // rung (globals.css). At <body> level this popover is a peer of the user
      // menu, so it uses the same rung rather than a fresh magic number.
      style={{
        zIndex: "var(--z-float)",
        transform: "translateY(-100%)",
        ...placement,
      }}
      // Belt to `innerRef`'s braces, and NOT a substitute for it. Stopping the
      // document-level `mousedown` an outside-click check listens on is not
      // enough: `useOutsideClick` also listens for `touchstart`, which nothing
      // here stops, so on a phone the menu would close on touchstart, before
      // the tap could become a click. Containment (innerRef) is the fix.
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}
