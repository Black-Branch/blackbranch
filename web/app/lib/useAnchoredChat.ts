"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// Shared scroll engine for the live chat and the Matrix timeline.
//
// The view is either ANCHORED (following new messages) or PAUSED (reading
// scrollback). The state is explicit and only user gestures change it —
// wheel, touch, held-pointer drags — never scroll-position deltas. Layout
// noise (panel-drag re-wraps, font-size changes, the mobile keyboard, emote
// loads, breakpoint crossings) therefore cannot drop the anchor: while
// anchored the bottom is asserted after every render and resize rather than
// tested for.
//
// While paused, the rendered list freezes at the pause boundary and newer
// items queue invisibly (`queued` feeds the pill), so reading position is
// pixel-stable — nothing past the boundary renders. Prepends (history
// pagination) still flow in above: call `captureAnchor()` right before one
// and the layout pass restores the exact reading position. For everything
// else that moves content above the viewport while paused (image loads,
// deletes), the scroller should enable native scroll anchoring —
// [overflow-anchor:auto] when paused, [overflow-anchor:none] when anchored,
// where it would fight the bottom lock.
//
// Re-anchoring happens only on a gesture landing within REANCHOR_PX of the
// bottom or an explicit `anchorToBottom()` (pill click, own message sent,
// room switch). Resume is atomic: flush, trim, and snap in one layout pass.
//
// The two thresholds are deliberately asymmetric. Pausing stays a hair-trigger
// (any deliberate upward gesture means "I'm reading"), but re-anchoring must
// match what the EYE calls the bottom: while paused the queued rows are not
// rendered, so a fling that decays a few dozen px short of the frozen list's
// end looks exactly like "at the bottom" while an 8px test says it isn't —
// "chat paused won't come back". One bottom-bar height (48px, the
// --chrome-bottom-h floor) of slack matches the eye.
//
// The slack is judged by DIRECTION as well as distance. Applied to every
// gesture scroll event, including the upward drag itself, a drag that has not
// yet crossed 48px is re-anchored on its next event (touchstart,
// scrollTop -= 15 per frame: `15→15 30→0 15→15 30→0` — the list snaps back on
// every second frame and the finger never gets past 30px) — the chat fights
// you by trying to hold it down. Only an event moving TOWARD the bottom is a
// landing; an event moving away is the drag, and a drag never re-anchors.

const PAUSE_PX = 8;
/** The landing slack (see above). Exported for the scroll keys, which must
 *  judge a page-down landing the way a touch landing is judged. */
export const REANCHOR_PX = 48;
const GESTURE_MS = 150;

export function useAnchoredChat<T>({
  items,
  getKey,
  onAnchored,
}: {
  /** Full live list — the consumer keeps ownership of buffering/merging. */
  items: T[];
  /** Stable unique key per item (same identity the rows render with). */
  getKey: (item: T) => string;
  /** Fires on every re-anchor — trim buffers, reset pagination windows. */
  onAnchored?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [anchored, setAnchoredState] = useState(true);
  const anchoredRef = useRef(true);

  // The previous scroll event's scrollTop — the DIRECTION of the current one
  // is what separates a landing from a drag away (see onScroll).
  const lastTopRef = useRef(0);

  // Keys of every item rendered at the moment of pausing — the freeze boundary.
  const [frozenKeys, setFrozenKeys] = useState<Set<string> | null>(null);

  // Latest-value refs so the stable event handlers below never go stale.
  const itemsRef = useRef(items);
  const getKeyRef = useRef(getKey);
  const onAnchoredRef = useRef(onAnchored);
  useLayoutEffect(() => {
    itemsRef.current = items;
    getKeyRef.current = getKey;
    onAnchoredRef.current = onAnchored;
  });

  // Distance-from-bottom captured just before a history prepend.
  const prependAnchorRef = useRef<number | null>(null);

  // Gesture bookkeeping — a scroll event is "the user's" only near these.
  const wheelUntilRef = useRef(0);
  const momentumUntilRef = useRef(0);
  const touchActiveRef = useRef(false);
  const pointerHeldRef = useRef(false);

  const setAnchored = useCallback((v: boolean) => {
    if (anchoredRef.current === v) return;
    anchoredRef.current = v;
    setFrozenKeys(v ? null : new Set(itemsRef.current.map((it) => getKeyRef.current(it))));
    setAnchoredState(v);
    if (v) onAnchoredRef.current?.();
  }, []);

  /** Call right before prepending older history. */
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (el) prependAnchorRef.current = el.scrollHeight - el.scrollTop;
  }, []);

  /** Re-anchor + flush the queue — pill click, own message, room switch. */
  const anchorToBottom = useCallback(() => {
    prependAnchorRef.current = null;
    momentumUntilRef.current = 0;
    setAnchored(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight; // assert now; the layout pass re-asserts post-flush
  }, [setAnchored]);

  /** Pause programmatically — a jump to an older message. The frozen boundary
   *  is the current newest item, so prepends (the pages the jump loaded)
   *  render and later arrivals queue for the pill, as with a gesture pause. */
  const pause = useCallback(() => setAnchored(false), [setAnchored]);

  // The frozen render slice: everything up to the newest item that was
  // visible when the user paused. Prepends land before the boundary and so
  // still render; appends past it count as queued. Searching back through
  // the frozen key set (instead of remembering one boundary key) keeps the
  // boundary valid through deletions and buffer trims.
  const rendered = useMemo(() => {
    if (anchored || !frozenKeys) return items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it && frozenKeys.has(getKey(it))) {
        return i === items.length - 1 ? items : items.slice(0, i + 1);
      }
    }
    return items; // nothing from pause time survives (mass trim) — give up gracefully
  }, [items, getKey, anchored, frozenKeys]);

  const queued = items.length - rendered.length;

  // Post-render layout pass: anchored asserts the bottom; paused restores the
  // pre-prepend reading position when one was captured.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchoredRef.current) {
      prependAnchorRef.current = null;
      el.scrollTop = el.scrollHeight;
    } else if (prependAnchorRef.current != null) {
      el.scrollTop = el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
    }
  }, [rendered, anchored]);

  /**
   * Reassert the bottom lock for a geometry change the hook can't see itself —
   * e.g. a sibling overlay (pinned-message banner) padding the scroller via
   * inline style from OUTSIDE React's render of `items`. A no-op while paused.
   * Callers should invoke this in a `useLayoutEffect` keyed on that geometry,
   * so it lands in the same paint as the DOM mutation that caused it.
   */
  const reassertBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el && anchoredRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Geometry changes that don't go through React: container resizes (panel
  // drag, keyboard, breakpoints) and content resizes (fonts, emote loads).
  // RO callbacks run after layout but before paint, so this never flickers.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const assertBottom = () => {
      if (anchoredRef.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(assertBottom);
    ro.observe(el);
    if (contentRef.current) ro.observe(contentRef.current);
    // Mobile keyboards that overlay instead of resizing the layout (iOS)
    // only announce themselves here.
    const vv = window.visualViewport;
    vv?.addEventListener("resize", assertBottom);
    return () => {
      ro.disconnect();
      vv?.removeEventListener("resize", assertBottom);
    };
  }, []);

  // User-intent listeners. The scrollbar is hidden (no-scrollbar), so wheel,
  // touch, and held-pointer drags (text selection, middle-click autoscroll)
  // are the only ways a human can scroll these panels.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastTopRef.current = el.scrollTop; // seed: the first event compares against where we mounted
    const onWheel = (e: WheelEvent) => {
      wheelUntilRef.current = performance.now() + GESTURE_MS;
      // Wheel-up pauses immediately — snappier than waiting for the scroll
      // event, and it works even from a sub-threshold nudge.
      if (e.deltaY < 0 && anchoredRef.current && el.scrollHeight - el.clientHeight > 1) {
        setAnchored(false);
      }
    };
    const onTouchStart = () => { touchActiveRef.current = true; };
    const onTouchEnd = () => {
      touchActiveRef.current = false;
      momentumUntilRef.current = performance.now() + GESTURE_MS;
    };
    const onPointerDown = () => { pointerHeldRef.current = true; };
    const onPointerUp = () => { pointerHeldRef.current = false; };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [setAnchored]);

  // Scroll events: gestures drive the state machine; anything else is layout
  // noise and, while anchored, gets corrected on the spot.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const t = performance.now();
    const isGesture =
      touchActiveRef.current ||
      pointerHeldRef.current ||
      t < wheelUntilRef.current ||
      t < momentumUntilRef.current;
    // Touch flings keep scrolling after the finger lifts — keep the gesture
    // window alive while paused so momentum reaching the bottom re-anchors.
    if (!anchoredRef.current && (touchActiveRef.current || t < momentumUntilRef.current)) {
      momentumUntilRef.current = t + GESTURE_MS;
    }
    // A wheel tick's smooth-scroll tail outlives the window the wheel event
    // opened (Firefox animates one tick for 200 ms by default), so its last
    // frames — the ones that LAND — would read as layout noise and the paused
    // list would never resume. Same cure as momentum: while paused, each tail
    // frame keeps the wheel window open for the next.
    if (!anchoredRef.current && t < wheelUntilRef.current) {
      wheelUntilRef.current = t + GESTURE_MS;
    }
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Re-anchoring is a LANDING judgment. Only an event that moved TOWARD the
    // bottom may re-anchor: a fling decaying short of the end, a drag coming
    // back down. An event moving AWAY is the drag itself, and re-anchoring it
    // snaps the list back under the finger — the L0.1 regression (below).
    const towardBottom = el.scrollTop > lastTopRef.current;
    if (isGesture) {
      if (anchoredRef.current && dist > PAUSE_PX) setAnchored(false);
      else if (!anchoredRef.current && towardBottom && dist <= REANCHOR_PX) anchorToBottom();
    } else if (anchoredRef.current && dist > 1) {
      el.scrollTop = el.scrollHeight;
    }
    lastTopRef.current = el.scrollTop; // after any correction above, so the next event sees the true position
  }, [setAnchored, anchorToBottom]);

  return {
    scrollRef,
    contentRef,
    /** Reactive anchor state — drives the pill and overflow-anchor mode. */
    anchored,
    /** Non-reactive read for event handlers / WS callbacks. */
    anchoredRef,
    /** What to render: the live list, or the frozen slice while paused. */
    rendered,
    /** Items held back past the freeze boundary (pill count). */
    queued,
    captureAnchor,
    anchorToBottom,
    /** Re-snap to bottom if anchored, for geometry changes outside `items`. */
    reassertBottom,
    /** Attach to the scroller's onScroll. */
    onScroll,
    pause,
  };
}
