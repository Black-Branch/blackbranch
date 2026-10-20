"use client";

import { useState, useRef } from "react";
import { lsGet, lsSet } from "@/app/lib/safeLocalStorage";

// ─── width-driven capacity model ──────────────────────────────────────────────
//
// The open room (timeline) is the anchor; the directory (left) and the right slot
// (members / thread) are slide-in toggles. The panel's own width — not the
// viewport — sets how many panels may coexist:
//   mode 1 (< 680px):  exactly one view at a time (mobile-Discord style)
//   mode 2 (≥ 680px):  timeline + at most one side panel (they push each other out)
//   mode 3 (≥ 1140px): directory open by default, members as an extra toggle

export const MODE2_AT = 680;
export const MODE3_AT = 1140;

export { useContainerWidth } from "@/app/lib/useContainerWidth";

function readPx(key: string, fallback: number): number {
  const v = parseInt(lsGet(key) ?? "", 10);
  return isNaN(v) ? fallback : v;
}

type PanelSide = "dir" | "mem" | "thread";

// Adjustable side-panel widths (persisted) + the drag-to-resize divider. Widths
// live in refs and the drag mutates the DOM directly — re-rendering the timeline
// per pointermove would jank. React re-reads the refs on its next render. The
// component reads `panelResizing` (to disable the slide transition mid-drag), the
// per-side width/outer/inner refs (for the panel `style.width`), and renders
// `panelDivider(side)` between panels.
export function usePanelLayout() {
  const [dirWInit] = useState(() => readPx("mxDirWidth", 240));
  const [memWInit] = useState(() => readPx("mxMemWidth", 208));
  const [threadWInit] = useState(() => readPx("mxThreadWidth", 360));
  const dirWRef = useRef(dirWInit);
  const memWRef = useRef(memWInit);
  const threadWRef = useRef(threadWInit);
  const dirOuterRef = useRef<HTMLDivElement>(null);
  const dirInnerRef = useRef<HTMLDivElement>(null);
  const memOuterRef = useRef<HTMLDivElement>(null);
  const memInnerRef = useRef<HTMLDivElement>(null);
  const threadOuterRef = useRef<HTMLDivElement>(null);
  const threadInnerRef = useRef<HTMLDivElement>(null);
  // Disables the slide transition while dragging so the drag stays 1:1
  const [panelResizing, setPanelResizing] = useState<null | PanelSide>(null);
  const resizingRef = useRef<null | PanelSide>(null);
  // Absolute drag anchor (pointer X + panel width at pointerdown). Width is
  // derived from the cursor's absolute delta, not accumulated `movementX` —
  // movementX drifts under fractional DPI / pointer capture and makes the
  // divider jitter. Absolute tracking stays pixel-exact for the whole drag.
  const dragAnchorRef = useRef({ x: 0, w: 0 });

  const SIDE = {
    dir: { wRef: dirWRef, outer: dirOuterRef, inner: dirInnerRef, min: 180, max: 420, key: "mxDirWidth" },
    mem: { wRef: memWRef, outer: memOuterRef, inner: memInnerRef, min: 160, max: 360, key: "mxMemWidth" },
    thread: { wRef: threadWRef, outer: threadOuterRef, inner: threadInnerRef, min: 260, max: 560, key: "mxThreadWidth" },
  } as const;

  const panelDivider = (side: PanelSide) => (
    <div
      className="w-1 shrink-0 cursor-col-resize flex justify-center group/divider touch-none"
      onPointerDown={(e) => {
        resizingRef.current = side;
        setPanelResizing(side);
        dragAnchorRef.current = { x: e.clientX, w: SIDE[side].wRef.current };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (resizingRef.current !== side) return;
        const cfg = SIDE[side];
        const anchor = dragAnchorRef.current;
        // dir grows when dragging right; right panels grow when dragging left.
        const delta = side === "dir" ? e.clientX - anchor.x : anchor.x - e.clientX;
        const w = Math.max(cfg.min, Math.min(cfg.max, anchor.w + delta));
        cfg.wRef.current = w;
        if (cfg.outer.current) cfg.outer.current.style.width = w + "px";
        if (cfg.inner.current) cfg.inner.current.style.width = w + "px";
      }}
      onPointerUp={() => {
        if (resizingRef.current !== side) return;
        resizingRef.current = null;
        setPanelResizing(null);
        lsSet(SIDE[side].key, String(Math.round(SIDE[side].wRef.current)));
      }}
    >
      <div className="w-px h-full bg-raised group-hover/divider:bg-surface-5 transition-colors" />
    </div>
  );

  return {
    panelResizing,
    panelDivider,
    dirWRef, dirOuterRef, dirInnerRef,
    memWRef, memOuterRef, memInnerRef,
    threadWRef, threadOuterRef, threadInnerRef,
  };
}
