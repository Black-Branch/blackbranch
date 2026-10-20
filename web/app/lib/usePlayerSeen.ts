"use client";
// Is the player box something a viewer can see right now?
//
// Seen = the page is visible AND the box intersects the viewport with a non-zero area. A zero-area
// edge touch counts as NOT seen: IntersectionObserver reports one as `isIntersecting: true`, which
// would keep the hidden chat pane counted as seen (animFence.ts has the same rule).
//
// MEASUREMENT ONLY. The answer feeds playerHealth's seen/unseen time and nothing else — no player
// is ever paused, rested or unmounted because of it.
import { useEffect, useState, type RefObject } from "react";

export function usePlayerSeen(ref: RefObject<HTMLElement | null>): boolean {
  // Nothing renders from this state, so reading the document in the initializer cannot disagree
  // with a server render.
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const read = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOnScreen(e.isIntersecting && e.intersectionRatio > 0);
    }, { threshold: [0, 0.001] });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return visible && onScreen;
}
