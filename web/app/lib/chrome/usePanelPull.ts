"use client";
// The TOP panel's gesture. A panel that comes
// down from the top of the chat is SIZED by its handle: the bottom edge follows
// the finger, from nothing up to the full size (topCap — the pane minus the
// strip kept clear for the newest messages). Let go and it stays there
// (`data-size="free"`, an inline height), unless the release lands near its
// own content size (snaps back to it, the stylesheet's content-fit) or near
// the full size / on a flick down (`data-size="cap"`). It closes only when
// pushed almost shut or flicked up hard (topRelease). Free sizing is the
// point: a gesture that springs back to fixed detents, or rubber-bands past a
// limit, leaves the panel impossible to position.
//
// Height, not translate: a top box moved by its translate would push its OWN
// band — the title and the ✕ — out through the layer's top edge. Resizing is a
// layout per pointer move on one absolutely-positioned box; the bottom panel's
// translate-only model exists because its box must stay glued to the composer.
import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { ownsKeyboard } from "./keyboardOwner";
import { DRAG_SLOP_PX, VELOCITY_WINDOW_MS, topCap, topRelease, velocity, type Sample } from "./panelGesture";
import { tweenHeight } from "./heightTween";

type Pull = { id: number; startY: number; h0: number; h: number; moved: boolean; samples: Sample[] };

export function usePanelPull({ panel, layer, onDismiss, onStart }: {
  panel: HTMLElement | null;
  layer: HTMLElement | null;
  onDismiss: () => void;
  onStart?: () => void;
}) {
  const g = useRef<Pull | null>(null);
  /** The content-fit height, remembered from a press at rest — a sized box
   *  cannot report it (its body is flex: 1). */
  const fitH = useRef<number | null>(null);
  const cancelTween = useRef<(() => void) | null>(null);

  const capH = useCallback((): number => {
    if (!layer) return 0;
    const ceiling = parseFloat(layer.ownerDocument.defaultView?.getComputedStyle(layer).getPropertyValue("--pane-ceiling") ?? "") || 0;
    return topCap(layer.getBoundingClientRect().height, ceiling, panel?.dataset.fill !== undefined || ownsKeyboard(panel));
  }, [layer, panel]);

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
    s.h = Math.max(0, Math.min(capH(), s.h0 + dy));
    panel.style.height = `${s.h}px`;
    s.samples.push({ t: e.timeStamp, y: s.h });
    while (s.samples.length > 2 && e.timeStamp - s.samples[0]!.t > 2 * VELOCITY_WINDOW_MS) s.samples.shift();
  }, [panel, capH]);

  const finish = useCallback((cancelled: boolean) => {
    const s = g.current;
    if (!s || !panel) return;
    g.current = null;
    delete panel.dataset.pull;
    const fit = fitH.current ?? s.h0;
    const r = cancelled
      ? (panel.dataset.size === undefined ? { kind: "fit" as const } : { kind: "free" as const, h: s.h0 })
      : topRelease({ h: s.h, h0: s.h0, fitH: fit, capH: capH(), vy: s.moved ? velocity(s.samples) : 0 });
    if (r.kind === "dismiss") { onDismiss(); return; }
    if (r.kind === "free") {
      panel.dataset.size = "free";
      panel.style.height = `${r.h}px`;
      panel.style.transition = "";
      return;
    }
    if (r.kind === "cap") {
      panel.dataset.size = "cap";
      cancelTween.current = tweenHeight(panel, s.h, capH(), true);
      return;
    }
    delete panel.dataset.size;
    cancelTween.current = tweenHeight(panel, s.h, fit);
  }, [panel, capH, onDismiss]);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(false);
  }, [finish]);
  const onPointerCancel = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(true);
  }, [finish]);
  /* eslint-enable react-hooks/immutability */

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
