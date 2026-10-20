"use client";

import { useCallback, useRef, useState } from "react";

export type Box = { x: number; y: number; w: number; h: number };
export type Corner = "nw" | "ne" | "sw" | "se";

type Options = {
  minW?: number;
  minH?: number;
  /** Keep at least this many px of the box on screen. */
  margin?: number;
  /** Height is content-driven until the user's first corner resize — `box.h` is
   *  ignored for rendering (`explicitH` stays false) and only becomes real when
   *  a resize gesture starts, seeded from `measureH` so the drag begins from the
   *  height the user actually sees. */
  autoHeight?: boolean;
  /** Rendered height of the panel, for seeding the first resize of an
   *  auto-height box (e.g. `() => ref.current?.offsetHeight ?? null`). */
  measureH?: () => number | null;
  /** Gesture-baseline adoption (the same rule `measureH` applies to height):
   *  called as a gesture begins; whatever it returns is merged into the
   *  gesture's start box AND committed, so the drag/resize starts from what
   *  the user actually sees. A corner resize adopting a floor-grown width is
   *  the user CHOOSING that width; a drag adopting a shifted x is just
   *  keeping the card under the pointer (move ≠ resize). */
  adopt?: (corner: Corner | null) => Partial<Box> | null;
};

/**
 * Drag-to-move + resize-from-corners for a floating panel.
 *
 * Built on Pointer Events, which unify mouse/touch/pen into ONE code path with
 * implicit capture — no parallel mousemove and touchmove handlers to keep in
 * step by hand.
 *
 * Clamping is asymmetric on purpose: the box may hang off the right/bottom
 * edges, but `margin` px of it always stays reachable, and it can never be
 * dragged above y=0 — a panel whose drag bar goes under the top of the viewport
 * can never be recovered with a pointer.
 */
export function useDragResize(
  initial: Box,
  { minW = 240, minH = 200, margin = 48, autoHeight = false, measureH, adopt }: Options = {}
) {
  const [box, setBox] = useState<Box>(initial);
  // False while an auto-height box has never been corner-resized. State for the
  // consumer's render + a ref so the pointerdown that flips it reads/writes
  // synchronously within its own gesture.
  const [explicitH, setExplicitH] = useState(!autoHeight);
  const explicitHRef = useRef(!autoHeight);
  // Non-null only while a gesture is in flight. Read by consumers to suppress
  // outside-click dismissal, which would otherwise fire on the pointerdown that
  // STARTS a drag.
  const gesture = useRef<{ px: number; py: number; start: Box; corner: Corner | null } | null>(null);

  const begin = useCallback(
    (corner: Corner | null) => (e: React.PointerEvent) => {
      // Ignore secondary buttons; let right-click reach the context menu.
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      let start = box;
      // First corner resize of an auto-height box: adopt the RENDERED height as
      // the gesture baseline, so the resize starts from what the user sees
      // rather than snapping to the never-rendered initial h.
      if (corner && !explicitHRef.current) {
        const measured = measureH?.();
        if (typeof measured === "number" && measured > 0) {
          start = { ...box, h: measured };
          setBox(start);
        }
        explicitHRef.current = true;
        setExplicitH(true);
      }
      const adopted = adopt?.(corner);
      if (adopted) {
        start = { ...start, ...adopted };
        setBox(start);
      }
      gesture.current = { px: e.clientX, py: e.clientY, start, corner };
    },
    [box, measureH, adopt]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.px;
      const dy = e.clientY - g.py;
      const vw = typeof window === "undefined" ? Infinity : window.innerWidth;
      const vh = typeof window === "undefined" ? Infinity : window.innerHeight;

      if (!g.corner) {
        // Shared with the open-panel viewport-change rescue in the chrome Window, so
        // "how far off-screen may a panel go" is stated once.
        setBox(
          reachableBox(
            { ...g.start, x: g.start.x + dx, y: g.start.y + dy },
            { width: vw, height: vh },
            margin
          )
        );
        return;
      }

      // Resizing from a west/north edge moves the origin as well as the size, so
      // the OPPOSITE edge stays put. Clamping the size first and deriving the
      // origin from it (rather than clamping both independently) is what stops
      // the box from creeping sideways once it hits minW/minH.
      const west = g.corner === "nw" || g.corner === "sw";
      const north = g.corner === "nw" || g.corner === "ne";
      const w = Math.max(minW, west ? g.start.w - dx : g.start.w + dx);
      const h = Math.max(minH, north ? g.start.h - dy : g.start.h + dy);
      setBox({
        w,
        h,
        x: west ? g.start.x + (g.start.w - w) : g.start.x,
        y: north ? g.start.y + (g.start.h - h) : g.start.y,
      });
    },
    [margin, minW, minH]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    gesture.current = null;
  }, []);

  /** Handlers for the drag bar. */
  const dragHandleProps = {
    onPointerDown: begin(null),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  /** Handlers for one resize corner. */
  const resizeHandleProps = (corner: Corner) => ({
    onPointerDown: begin(corner),
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  });

  return {
    box,
    setBox,
    dragHandleProps,
    resizeHandleProps,
    /** False only for an `autoHeight` box the user has never corner-resized —
     *  render `height: auto` (with a viewport clamp) while false. */
    explicitH,
    /** True while a drag/resize is in flight. */
    isGesturing: () => gesture.current !== null,
  };
}

/**
 * Starting box for a panel centred over a host element (the chat column),
 * clamped so it is fully on screen.
 *
 * Centred rather than anchored to the clicked username: an anchored card
 * pushed off-screen by a click near the viewport edge has no good remedy, and
 * centring over the host removes the dependency on where the click landed.
 */
/**
 * Keep `margin` px of a box reachable by pointer.
 *
 * This IS the drag clamp — `begin()` above calls it, so the rule a drag obeys
 * and the rule a viewport change obeys cannot drift apart. Asymmetric on
 * purpose: a box may hang off the right/bottom edges, but never above y=0,
 * because a drag bar under the top of the viewport can never be grabbed again.
 *
 * Deliberately WEAKER than `clampGeom` (panelGeometry.ts), which is what a
 * restore uses. Hanging a card half off the edge is a choice the user is making
 * and watching, so a resize must not undo it — this only rescues a panel that a
 * viewport change has put out of reach, and returns an equal box for one that
 * is already reachable. Re-fitting on every resize event instead would snap a
 * just-dragged card back to the middle, which reads as the app fighting you.
 */
export function reachableBox(
  box: Box,
  viewport: { width: number; height: number },
  margin = 48
): Box {
  return {
    ...box,
    x: Math.min(Math.max(box.x, margin - box.w), Math.max(viewport.width - margin, margin - box.w)),
    y: Math.min(Math.max(box.y, 0), Math.max(viewport.height - margin, 0)),
  };
}

export function centeredBox(
  host: { left: number; top: number; width: number; height: number } | null,
  w: number,
  h: number,
  viewport: { width: number; height: number },
  margin = 8
): Box {
  const cx = host ? host.left + host.width / 2 : viewport.width / 2;
  const cy = host ? host.top + host.height / 2 : viewport.height / 2;
  const width = Math.min(w, viewport.width - margin * 2);
  const height = Math.min(h, viewport.height - margin * 2);
  return {
    w: width,
    h: height,
    x: Math.min(Math.max(cx - width / 2, margin), viewport.width - width - margin),
    y: Math.min(Math.max(cy - height / 2, margin), viewport.height - height - margin),
  };
}
