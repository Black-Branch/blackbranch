"use client";
// The TOP panel's gesture. A panel that comes
// down from the top of the chat is SIZED by its handle: the bottom edge follows
// the finger, from nothing to the whole visible pane (paneCap — the same travel
// a bottom panel has toward the ceiling). It moves by THE SAME rule as a bottom
// panel (#234, k: "slide down pages don't act like slide up pages"): below its
// own size a release stays where it was let go (`data-size="free"`, an inline
// height) unless it is pushed almost shut or flicked toward closed (up); a
// flick toward open goes to its own size; above its own size it lands on its
// own size or the full pane (`data-size="cap"`), whichever the midpoint says,
// or the one a flick points at. panelGesture.ts releaseBySize / cancelBySize
// ask usePanelDrag's own releaseTarget / cancelTarget, the direction turned
// around once there. A task's only detent is the full pane.
//
// Height, not translate: a top box moved by its translate would push its OWN
// band — the title and the ✕ — out through the layer's top edge. Resizing is a
// layout per pointer move on one absolutely-positioned box; the bottom panel's
// translate-only model exists because its box must stay glued to the composer.
// The landings ease on the same token curve as a bottom panel's translate
// (heightTween.ts: var(--anim-default) var(--anim-ease)).
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { paneCap } from "./panelFollow";
import { DRAG_SLOP_PX, VELOCITY_WINDOW_MS, cancelBySize, releaseBySize, velocity, type Sample } from "./panelGesture";
import { tweenHeight } from "./heightTween";

type Pull = { id: number; startY: number; h0: number; h: number; moved: boolean; samples: Sample[] };

export function usePanelPull({ panel, layer, kind, onDismiss, onStart }: {
  panel: HTMLElement | null;
  layer: HTMLElement | null;
  kind: "peek" | "task";
  onDismiss: () => void;
  onStart?: () => void;
}) {
  const g = useRef<Pull | null>(null);
  /** The content-fit height, remembered from a press at rest — a sized box
   *  cannot report it (its body is flex: 1). */
  const fitH = useRef<number | null>(null);
  const cancelTween = useRef<(() => void) | null>(null);

  /* eslint-disable react-hooks/immutability -- `panel` is a DOM element handle, not React state; writing its inline height and data attributes IS this hook's job, and the rule also flags the callbacks that only read it (usePanelDrag.ts's exact disposition) */
  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (!panel || e.button !== 0 || g.current) return;
    if ((e.target as Element).closest('button, [role="button"], a, input, select, textarea')) return;
    if (panel.dataset.closing !== undefined || panel.dataset.entered === undefined) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === "function") el.setPointerCapture(e.pointerId);
    onStart?.();
    cancelTween.current?.();
    cancelTween.current = null;
    const h0 = panel.offsetHeight;
    if (panel.dataset.size === undefined || fitH.current === null) fitH.current = h0;
    g.current = { id: e.pointerId, startY: e.clientY, h0, h: h0, moved: false, samples: [{ t: e.timeStamp, y: h0 }] };
    panel.dataset.pull = "";
    panel.style.transition = "none";
    panel.style.height = `${h0}px`;
  }, [panel, onStart]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const s = g.current;
    if (!s || !panel || e.pointerId !== s.id) return;
    const dy = e.clientY - s.startY;
    if (!s.moved) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      s.moved = true;
    }
    s.h = Math.max(0, Math.min(paneCap(layer), s.h0 + dy));
    panel.style.height = `${s.h}px`;
    s.samples.push({ t: e.timeStamp, y: s.h });
    while (s.samples.length > 2 && e.timeStamp - s.samples[0]!.t > 2 * VELOCITY_WINDOW_MS) s.samples.shift();
  }, [panel, layer]);

  const finish = useCallback((cancelled: boolean) => {
    const s = g.current;
    if (!s || !panel) return;
    g.current = null;
    const capH = paneCap(layer);
    const fitV = kind === "task" ? capH : (fitH.current ?? s.h0);
    // Samples are the box's height, so a positive speed is toward OPEN.
    const r = cancelled
      ? cancelBySize(s.h, fitV, capH)
      : releaseBySize(s.h, s.moved ? velocity(s.samples) : 0, fitV, capH);
    // Every way out flushes the held height (transition `none`, the last
    // move's px) BEFORE the transition comes back: restoring it in the same
    // task would ease a fillable box from the last RENDERED height
    // (feedback: a hold and its release need a flush between them).
    void panel.offsetHeight;
    delete panel.dataset.pull;
    if (r.kind === "dismiss") {
      panel.style.transition = "";
      onDismiss();
      return;
    }
    if (r.kind === "free") {
      panel.dataset.size = "free";
      if (Math.abs(r.v - s.h) < 0.5) { panel.style.transition = ""; return; }
      // A cancel under the minimum is raised to it — eased, and kept as the size.
      cancelTween.current = tweenHeight(panel, s.h, r.v, true);
      return;
    }
    if (r.kind === "cap") {
      // The full pane rests as the stylesheet's rule (chrome.css
      // [data-size="cap"]), not a px: a keyboard opening under it must take
      // the box with the pane, the way a bottom panel's cap box follows.
      panel.dataset.size = "cap";
      cancelTween.current = tweenHeight(panel, s.h, capH);
      return;
    }
    delete panel.dataset.size;
    cancelTween.current = tweenHeight(panel, s.h, Math.min(fitV, capH));
  }, [panel, layer, kind, onDismiss]);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(false);
  }, [finish]);
  const onPointerCancel = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(true);
  }, [finish]);
  /* eslint-enable react-hooks/immutability */

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
