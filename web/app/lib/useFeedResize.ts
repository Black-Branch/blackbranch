import { useRef, useEffect, type RefObject } from "react";
import { lsGet, lsSet } from "./safeLocalStorage";

// Desktop drag-to-fill: a handle between the video and the feed reserves a
// minimum feed height (--feed-height on the column). The video calc subtracts it
// (globals.css), so dragging up grows the feed and pushes the video out; 0 = pure
// responsive. Lives in a CSS var (no per-frame React render), like the chat resize.
export function useFeedResize(videoColRef: RefObject<HTMLDivElement | null>) {
  const feedManualRef = useRef(0);
  const feedResizing = useRef(false);
  const applyFeedManual = (h: number) => {
    feedManualRef.current = h;
    videoColRef.current?.style.setProperty("--feed-height", `${h}px`);
  };
  useEffect(() => {
    const saved = parseInt(lsGet("feed_manual_h") ?? "", 10);
    if (!Number.isNaN(saved) && saved > 0) applyFeedManual(saved);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- restore the saved height once on mount. applyFeedManual is a plain function re-created every render, so listing it would re-apply the SAVED height on every render and stamp on a drag in progress
  }, []);
  const feedMaxManual = () => {
    const c = videoColRef.current;
    return c ? Math.max(0, c.clientHeight - 8) : 600;
  };
  const feedResizeHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      feedResizing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!feedResizing.current) return;
      applyFeedManual(Math.max(0, Math.min(feedMaxManual(), feedManualRef.current - e.movementY)));
    },
    onPointerUp: () => {
      feedResizing.current = false;
      lsSet("feed_manual_h", String(Math.round(feedManualRef.current)));
    },
  };

  return { feedResizeHandlers };
}
