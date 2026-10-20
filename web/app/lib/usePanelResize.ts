"use client";

import { useState, useRef, useEffect, type RefObject } from "react";
import { lsGet, lsSet, lsRemove } from "@/app/lib/safeLocalStorage";
import { useClientValue } from "@/app/lib/useClientState";
import { snapZoneFor, type SnapZone } from "@/app/lib/panelSnap";

// Encapsulates the stream/chat panel resize + magnetic-snap state machine, so
// StreamView does not carry it inline.
//
// The drag runs a continuum from a folded chat (chatFolded) to full-screen
// community (video collapsed). Crossing a magnetic zone (see panelSnap.ts)
// arms a snap that commits on pointer release; between zones the drag is
// free. Theatre mode is reached by NO route through this drag — only its
// button / Alt+R arm it.
//
// Perf note: resizing animates --chat-width / flex, which reflows the video
// iframe every frame and can feel sluggish. A transform-based resize is the
// candidate improvement, and this hook is the clean surface for it.

export type PanelMode = "normal" | "theatre" | "full" | "chatFolded";

const CHAT_MIN = 200;
const CHAT_DEFAULT = 320;
// Must match --anim-slow in globals.css
const ANIM_SLOW_MS = 300;
const EDGE_GAP = 60;       // chat never visually exceeds viewport minus this

export type ResizeHandlers = {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
};

export function usePanelResize({
  rootRef,
  narrow,
  defaultMode = "normal",
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  narrow: boolean;
  /** The mode when nothing is stored — the server render and a fresh device.
   *  StreamView passes the visit's shape (chatFolded when offline) so the
   *  first paint is already right; nothing here persists it. */
  defaultMode?: PanelMode;
}) {
  const isResizing = useRef(false);
  // Tracks current width for clamping during drag — never drives React renders
  const chatWidthRef = useRef(CHAT_DEFAULT);
  // Unclamped drag position — runs past the visual clamps into the snap zones
  const rawWidthRef = useRef(CHAT_DEFAULT);
  // Persisted mode restores hydration-safely (null during SSR → "normal");
  // after the first applyMode() the local override drives the value and the
  // localStorage writes below keep the persisted copy in sync.
  const [panelModeOverride, setPanelMode] = useState<PanelMode | null>(null);
  const savedMode = useClientValue(() => lsGet("panelMode"), null);
  const panelMode: PanelMode =
    panelModeOverride ??
    (savedMode === "theatre" || savedMode === "full" || savedMode === "chatFolded" ? savedMode : defaultMode);
  const [snapZone, setSnapZone] = useState<SnapZone | null>(null);
  const [snapping, setSnapping] = useState(false);

  function applyMode(mode: PanelMode) {
    setSnapZone(null);
    if (mode === "normal") {
      lsRemove("panelMode");
      const saved = parseInt(lsGet("chatWidth") ?? "", 10);
      const w = isNaN(saved)
        ? CHAT_DEFAULT
        : Math.min(window.innerWidth - EDGE_GAP, Math.max(CHAT_MIN, saved));
      chatWidthRef.current = w;
      rawWidthRef.current = w;
      document.documentElement.style.setProperty("--chat-width", w + "px");
    } else {
      lsSet("panelMode", mode);
    }
    // Snapping must render BEFORE panelMode changes: the transition class must
    // already be on the DOM when the width/flex properties change, otherwise
    // React's batching applies both in the same frame and nothing animates.
    setSnapping(true);
    requestAnimationFrame(() => {
      setPanelMode(mode);
      setTimeout(() => setSnapping(false), ANIM_SLOW_MS + 50);
    });
  }

  // Sync chatWidthRef from localStorage on mount (CSS var already set by blocking script)
  useEffect(() => {
    const saved = parseInt(lsGet("chatWidth") ?? "", 10);
    const maxW = window.innerWidth - EDGE_GAP;
    chatWidthRef.current = isNaN(saved) ? CHAT_DEFAULT : Math.min(maxW, Math.max(CHAT_MIN, saved));
    rawWidthRef.current = chatWidthRef.current;
  }, []);

  // Full mode stays width-driven (flex classes never change) so the snap
  // animates --chat-width numerically — switching to flex-1 made flex-basis
  // jump auto→0% and the panel collapsed before the transition played.
  // Covers the mount-restored case and tracks window resizes while full.
  useEffect(() => {
    if (narrow || panelMode !== "full") return;
    const apply = () => {
      const root = rootRef.current;
      if (!root) return;
      const cs = getComputedStyle(root);
      const w = root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      chatWidthRef.current = w;
      rawWidthRef.current = w;
      document.documentElement.style.setProperty("--chat-width", w + "px");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [panelMode, narrow, rootRef]);

  // Pointer handlers for the resize divider (rendered only in normal mode).
  const resizeHandlers: ResizeHandlers = {
    onPointerDown: (e) => {
      isResizing.current = true;
      rawWidthRef.current = chatWidthRef.current;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      if (!isResizing.current) return;
      const maxW = window.innerWidth - EDGE_GAP;
      const raw = rawWidthRef.current - e.movementX;
      rawWidthRef.current = raw;
      const next = Math.max(CHAT_MIN, Math.min(maxW, raw));
      chatWidthRef.current = next;
      document.documentElement.style.setProperty("--chat-width", next + "px");
      setSnapZone(snapZoneFor(raw, window.innerWidth));
    },
    onPointerUp: () => {
      isResizing.current = false;
      if (snapZone) {
        applyMode(snapZone);
      } else {
        lsSet("chatWidth", String(chatWidthRef.current));
      }
      rawWidthRef.current = chatWidthRef.current;
    },
  };

  return { panelMode, snapZone, snapping, applyMode, resizeHandlers };
}
