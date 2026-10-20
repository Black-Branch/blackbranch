"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { STICKER_BASE_COINS, stickerBoostScale } from "./coins";
import type { ChatMsg } from "./chatMsg";

// How long a re-settled sticker sits at its OLD size before growing to the
// new one — enough of a beat that arrival and growth read as two separate
// steps, not simultaneous.
const STICKER_GROW_DELAY_MS = 200;

// Sticker-boost animation for one chat row: the FLIP slide when a boosted sticker
// reorders to the bottom, plus the delayed grow of the emote itself. Extracted from
// ChatMessage so that 567-line component isn't also carrying three interdependent
// layout effects. Returns the row container ref, the sticker <img> ref, and the
// current render scale for the sticker image. The effect DECLARATION ORDER here is
// load-bearing (FLIP-measure → position-track → grow) — see the notes below.
export function useStickerGrow(msg: ChatMsg) {
  // Sticker boost move: a genuine FLIP slide instead of a fade out/in pair —
  // the row reorders to the bottom in ONE state update (useChatMessages.ts),
  // and this effect makes that instant DOM jump LOOK like continuous motion:
  // measure this row's position, and if `_justMoved` fired this render,
  // compute the delta from where it sat last render, snap a compensating
  // inverse transform on with transitions suppressed (invisible — same
  // pixels, just expressed as a transform now), then a frame later transition
  // that transform back to 0, which the browser animates as a slide from the
  // old position to the new one. The position-tracking write below must run on
  // EVERY render (not just moves) so it's always ready as the "before" reference
  // the next time a move happens — hence two effects in this exact order, not one.
  const rowRef = useRef<HTMLDivElement>(null);
  const prevTopRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || !msg._justMoved || prevTopRef.current == null) return;
    const delta = prevTopRef.current - el.getBoundingClientRect().top;
    if (Math.abs(delta) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.style.transition = "none";
    el.style.transform = `translateY(${delta}px)`;
    void el.offsetHeight; // force reflow so the browser commits the snap before animating
    const raf = requestAnimationFrame(() => {
      el.style.transition = `transform var(--anim-default) var(--anim-ease)`;
      el.style.transform = "translateY(0)";
    });
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "transform") return;
      el.style.transition = "";
      el.style.transform = "";
    };
    el.addEventListener("transitionend", onEnd);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("transitionend", onEnd);
    };
  }, [msg._justMoved, msg._prevBoostCoins]);
  useLayoutEffect(() => {
    if (rowRef.current) prevTopRef.current = rowRef.current.getBoundingClientRect().top;
  });

  // Sticker boost grow: once the row has settled at its final position (no
  // move needed, or the move/collapse above already finished), the emote
  // itself grows from its PRE-boost size to the new one as a distinct second
  // step — never simultaneously with arrival. The "rest at the old size"
  // value is pure-derived from props during render (no effect needed for
  // that part); the effect below only handles the DELAYED half — clearing
  // the transition-suppression and setting the real target a beat later so
  // `.sticker-grow`'s CSS transition animates the growth, which genuinely
  // does need to happen after a timeout, not during render.
  const stickerImgRef = useRef<HTMLImageElement>(null);
  const [growScale, setGrowScale] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (msg._prevBoostCoins == null) return;
    if (stickerImgRef.current) stickerImgRef.current.style.transition = "none";
    const t = setTimeout(() => {
      if (stickerImgRef.current) stickerImgRef.current.style.transition = "";
      setGrowScale(stickerBoostScale(msg.boostCoins ?? STICKER_BASE_COINS));
    }, STICKER_GROW_DELAY_MS);
    return () => clearTimeout(t);
    // `boostCoins` is listed even though `_prevBoostCoins` is the arrival edge:
    // both writers stamp them in the SAME state update (useChatMessages.ts,
    // ChatOverlay.tsx), so it cannot fire alone — but nothing enforces that
    // coupling, and the failure it would cause is a MISSED grow. A dependency
    // list correct only by coincidence is the exhaustive-deps warning's shape.
  }, [msg.id, msg._prevBoostCoins, msg.boostCoins]);

  // Between boosts `growScale` holds steady at the last-grown value; before the
  // first grow it's the pre-boost (or current) size, derived from props.
  const stickerScale = growScale ?? stickerBoostScale(msg._prevBoostCoins ?? msg.boostCoins ?? STICKER_BASE_COINS);

  return { rowRef, stickerImgRef, stickerScale };
}
