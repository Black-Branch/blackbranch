"use client";

// The panel window's handle gesture.
//
// ONE scalar drives the vertical gesture: the panel's translate Y on a box
// held at CAP height (`data-drag`, chrome.css: `height: calc(100% -
// var(--pane-ceiling))`). 0 = the cap (the panel's top on the ceiling);
// `fit` = contentFit = capHeight − contentHeight, where the cap box translated
// by `fit` occupies EXACTLY the visible region of the resting content-fit box
// (its overhang below the composer is clipped by the layer); below `fit` the
// scalar is a POSITION: the panel can be pulled down and left there without
// closing, so the chat behind it stays visible while the panel is in use. So a drag from rest at
// contentFit begins by switching to the cap box AND setting translate = fit in
// the same frame (visually nothing happens), follows the finger 1:1 through
// `dragOffset`, and on release either eases (`releaseTranslate`) to a detent —
// contentFit or the cap, above contentFit — or, below contentFit, PARKS: the
// box stays exactly where the finger let go, in the cap box, as
// `data-detent="free"` with its translate kept (it has no resting rule of its
// own). When a detent's transition ends, `settle` restores the resting box —
// content-fit at translate 0, or `data-detent="cap"` at translate 0 — again at
// an identical visible region. Nothing lays out per frame; nothing paints on a
// switch. Closing is a release with less than MIN_VISIBLE_PX of the box still
// showing, or a downward flick from below contentFit: the box is left where
// the finger let go and `requestClose` runs `panel-seam-out` on `transform`
// from there (the properties add), so the exit continues the gesture.
//
// Arbitration with the horizontal pager is CSS (`touch-action: pan-x` on the handle,
// chrome.css): a horizontal pan is the browser's, and it tells us so with a
// `pointercancel`, which lands the box on the nearest detent above contentFit
// or leaves it parked below it (raised to the floor if the finger had it under
// the minimum) — never a dismiss. A press on anything interactive in the band
// is not a drag (the same `closest()` guard the floating window's handle
// uses). `preventDefault` on the press suppresses the compat mousedown that
// would move focus — keepFocus.ts's rule, one level down: dragging the card
// must not cost the keyboard.
//
// Composition with the lift-follow (the keyboard's own motion on the same
// `translate`): a press while `data-lifting` holds the box is IGNORED (the
// hold lasts ≤ 250ms; the next press works) so the two holds never overlap;
// while a release transition is in flight, `restTranslate` tells the
// lift-follow where the drag is heading — the pending detent recomputed
// against the CURRENT cap — so a keyboard commit mid-snap retargets to the
// right place instead of to 0, and that commit RE-ARMS the settle backstop
// because the snap it retargeted is a fresh transition; a commit that lands
// with the finger still DOWN cancels the gesture first (never a dismiss), so
// the lift has a resting place to aim at rather than easing the box to the
// cap under the finger. A PARKED box reports the scalar that keeps its
// VISIBLE HEIGHT: it was parked against the composer, and the composer is
// what moves with the keyboard — so across a K commit it rides the pane and
// shows the same amount, clamped at the cap when the pane gets too short.
//
// Composition with the entry and exit animations: a press is ignored while
// either runs (`data-entered` unset, or `data-closing` set). panel-seam-in/out
// translate by a PERCENTAGE of the panel's own height, so switching to the cap
// box mid-slide would re-target their base — the same stutter PanelWindow's
// entry-height freeze exists to prevent.

import { useCallback, useEffect, useRef, type RefObject, type PointerEvent as ReactPointerEvent } from "react";
import { currentTranslateY, holdTranslate, releaseTranslate, setParkPad } from "./panelFollow";
import { DRAG_SLOP_PX, VELOCITY_WINDOW_MS, dragOffset, cancelTarget, releaseTarget, velocity, type Sample } from "./panelGesture";
import { KB_LIFT_EVENT, type KbLiftDetail } from "@/app/lib/useViewportHeightVar";

type PanelDragHandlers = {
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: (e: ReactPointerEvent) => void;
  onPointerCancel: (e: ReactPointerEvent) => void;
};

/** Same value and reason as Window.tsx's PANEL_ANIM_BACKSTOP_MS: a release
 *  whose transitionend never comes (reduced motion) must still settle. */
const SETTLE_BACKSTOP_MS = 250;

type Gesture = {
  id: number;
  startClientY: number;
  /** The scalar at the press — where the box visually was, in the cap-box model. */
  y0: number;
  fit: number;
  /** The cap box's height at the press: the pane minus the ceiling. */
  capH: number;
  /** Content height at the press; `fit` is recomputed from it against the live cap. */
  fitH: number;
  y: number;
  moved: boolean;
  samples: Sample[];
};

/** Where a released box is heading, and what it rests in when it arrives. A
 *  detent rests in its own box (content-fit, or `data-detent="cap"`) at
 *  translate 0; a parked position ("free") stays in the cap box at the
 *  scalar that keeps `visibleH` of it above the composer. */
type Pending =
  | { detent: "fit" | "cap"; fitH: number }
  | { detent: "free"; fitH: number; visibleH: number };

export function usePanelDrag({ panel, layer, kind, restTranslate: restTranslateRef, onDismiss, onStart }: {
  panel: HTMLElement | null;
  layer: HTMLElement | null;
  kind: "peek" | "task";
  /** Read by the lift-follow: the translate the panel rests at in its CURRENT box. */
  restTranslate: RefObject<() => number>;
  onDismiss: () => void;
  /** The press begins a gesture — the entry-height freeze must let go (an
   *  inline height would beat the cap-box rule and lift the box off the composer). */
  onStart?: () => void;
}): PanelDragHandlers {
  const g = useRef<Gesture | null>(null);
  const pending = useRef<Pending | null>(null);
  const backstop = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The RESTING box's height — the hook's memory of contentFit, because no
   *  measurement taken inside a cap-height box can report it: the body is
   *  `flex: 1` and `scrollHeight` is floored at `clientHeight`, so in the cap
   *  box short content reads back the BOX (fit = 0: no range to drag back
   *  through, and a spring-back that collapses the box). The resting box IS
   *  `min(contentHeight, capHeight)`, so a press from rest records it.
   *  Content that grows while the panel rests AT the cap detent, or parked,
   *  is not seen — the box is cap height there and nothing re-measures — so
   *  the memory is stale until the next settle to contentFit refreshes it;
   *  that one settle may pop by the growth. The alternative is a per-frame
   *  measurement of a box that cannot answer the question. */
  const restingH = useRef<number | null>(null);
  /** A PARKED box's memory: how much of it shows above the composer. Set when
   *  a release parks the box, cleared by any settle to a detent. Across a K
   *  change this is what stays — see `restTranslate` below. */
  const parkedVisibleH = useRef<number | null>(null);

  /** The cap box's height against the LIVE ceiling. The layer's rect, never
   *  `clientHeight`: the layer has no border, and `clientHeight` rounds to an
   *  integer while the pane's real height is fractional. */
  const capHeight = useCallback((): number => {
    if (!layer) return 0;
    const ceiling = parseFloat(layer.ownerDocument.defaultView?.getComputedStyle(layer).getPropertyValue("--pane-ceiling") ?? "") || 0;
    return layer.getBoundingClientRect().height - ceiling;
  }, [layer]);

  /** contentFit's scalar, and the cap, for a resting box of height `fitH`. */
  const geometry = useCallback((fitH: number): { fit: number; capH: number } => {
    const capH = capHeight();
    return { fit: kind === "task" ? 0 : Math.max(0, capH - Math.min(fitH, capH)), capH };
  }, [capHeight, kind]);

  /** The scalar a pending release is heading for, against the CURRENT cap. */
  const restOf = useCallback((p: Pending): number => {
    if (p.detent === "free") return Math.max(0, capHeight() - p.visibleH);
    return p.detent === "cap" ? 0 : geometry(p.fitH).fit;
  }, [geometry, capHeight]);

  // Where the box rests in its current model: the pending target while a
  // gesture's box is held, a parked box's position against the current cap,
  // 0 otherwise. Re-derived on every read so a keyboard commit sees contentFit
  // — or the parked visible height — against the NEW cap.
  useEffect(() => {
    restTranslateRef.current = () => {
      if (!panel) return 0;
      const p = pending.current;
      if (p && panel.dataset.drag !== undefined) return restOf(p);
      if (panel.dataset.detent === "free" && parkedVisibleH.current !== null) return Math.max(0, capHeight() - parkedVisibleH.current);
      return 0;
    };
    return () => { restTranslateRef.current = () => 0; };
  }, [panel, restOf, capHeight, restTranslateRef]);

  /** The release arrived (or had nowhere to go): leave the held box for what
   *  `p` rests in. A detent gets its resting box with the scalar zeroed in the
   *  same frame — identical visible region either way. A parked position keeps
   *  the cap box AND the scalar: wherever the box actually is now (the target,
   *  or where a lost transitionend left it) is where it stays, and its visible
   *  height is recorded from there. */
  /* eslint-disable react-hooks/immutability -- `panel` is a DOM element handle, not React state to keep immutable; writing its data attributes and translate IS this hook's job, and the rule also flags the callbacks that only read it */
  const settle = useCallback((p: Pending) => {
    if (!panel) return;
    if (backstop.current) { clearTimeout(backstop.current); backstop.current = null; }
    pending.current = null;
    if (p.detent === "free") {
      const y = currentTranslateY(panel);
      panel.dataset.detent = "free";
      delete panel.dataset.drag;
      parkedVisibleH.current = capHeight() - y;
      holdTranslate(panel, y);
      // The box now hangs `y` past the clip edge, and the body is sized by the
      // box: without this its scroll range ends with those `y` pixels still
      // hidden, so the bottom of the content cannot be reached at all (see
      // setParkPad). Written here, at rest, never per frame.
      setParkPad(panel, y);
      void panel.offsetHeight;
      panel.style.transitionProperty = "";
      return;
    }
    parkedVisibleH.current = null;
    setParkPad(panel, 0);   // back in a resting box: nothing is clipped, nothing to pad
    if (p.detent === "cap" && kind !== "task") panel.dataset.detent = "cap"; else delete panel.dataset.detent;
    delete panel.dataset.drag;
    holdTranslate(panel, 0);
    void panel.offsetHeight;
    // The RESTING box is back (content-fit for a peek; a task's is the cap
    // box it always has) and this read is after the flush that applied it:
    // refresh the memory, so growth that landed while the panel sat at the
    // cap detent or parked is picked up here. Settling AT the cap leaves it
    // alone — that box is cap height and says nothing about the content.
    if (p.detent === "fit") restingH.current = panel.offsetHeight;
    panel.style.transitionProperty = "";
  }, [panel, kind, capHeight]);

  useEffect(() => {
    if (!panel) return;
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== panel || e.propertyName !== "translate") return;
      const p = pending.current;
      if (p) settle(p);
    };
    panel.addEventListener("transitionend", onTransitionEnd);
    return () => {
      panel.removeEventListener("transitionend", onTransitionEnd);
      if (backstop.current) { clearTimeout(backstop.current); backstop.current = null; }
    };
  }, [panel, settle]);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    if (!panel || !layer || e.button !== 0) return;
    if (g.current) return; // a gesture is already in progress — a second pointer does not take over
    if ((e.target as Element).closest('button, [role="button"], a, input, select, textarea')) return;
    if (panel.dataset.lifting !== undefined) return; // the keyboard's hold wins; the next press works
    // Neither entry nor exit may be interrupted: both run panel-seam-in/out,
    // whose translate is a PERCENTAGE of the panel's own height, so switching
    // to the cap box mid-slide re-targets the animation's base — exactly the
    // stutter the entry-height freeze exists to prevent. `data-entered` is
    // PanelWindow's mark that the entry landed (or that there was nothing to
    // freeze); `data-closing` says the exit is armed.
    if (panel.dataset.closing !== undefined) return;
    if (panel.dataset.entered === undefined) return;
    // preventDefault suppresses the compat mousedown that would move focus
    // (keepFocus.ts's rule one level down). NO stopPropagation, deliberately —
    // unlike the floating window's handle (useDragResize's `begin`), which
    // stops it: an outside-press dismiss listener on `document`
    // (FloatingPicker's, e.g. the emote picker) must still SEE this press, or
    // a picker left open behind the panel would survive the whole drag.
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    if (typeof el.setPointerCapture === "function") el.setPointerCapture(e.pointerId); // jsdom has no capture; a browser always does
    onStart?.();
    if (backstop.current) { clearTimeout(backstop.current); backstop.current = null; }
    // Adopt the visual. contentFit is the resting box's height — measured here
    // when the press comes FROM rest, remembered otherwise (`restingH`: the cap
    // detent, a parked box, or a snap still in flight are all the cap box);
    // the fallback covers only a cap box with no memory at all, whose `fit` a
    // task makes 0 anyway. The scalar at the press is wherever the box IS —
    // the cap box's live translate, plus `fit` when the press leaves the
    // content-fit box.
    const inCapBox = panel.dataset.drag !== undefined || panel.dataset.detent === "cap" || panel.dataset.detent === "free";
    const fitH = inCapBox ? (restingH.current ?? panel.offsetHeight) : panel.offsetHeight;
    if (!inCapBox) restingH.current = fitH;
    const { fit, capH } = geometry(fitH);
    const y0 = (inCapBox ? 0 : fit) + currentTranslateY(panel);
    pending.current = null;
    panel.dataset.drag = "";
    holdTranslate(panel, y0);
    g.current = {
      id: e.pointerId, startClientY: e.clientY, y0, fit, capH, fitH, y: y0, moved: false,
      samples: [{ t: e.timeStamp, y: y0 }],
    };
  }, [panel, layer, geometry, onStart]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const s = g.current;
    if (!s || !panel || e.pointerId !== s.id) return;
    const dy = e.clientY - s.startClientY;
    if (!s.moved) {
      if (Math.abs(dy) < DRAG_SLOP_PX) return;
      s.moved = true;
    }
    s.y = dragOffset(s.y0, dy, s.capH);
    holdTranslate(panel, s.y);
    s.samples.push({ t: e.timeStamp, y: s.y });
    // Prune by TIME, not by a fixed sample count: a count spans ~100ms at
    // 120Hz and half a second at 24Hz, and velocity() anchors its window on
    // the oldest sample still older than VELOCITY_WINDOW_MS — so on a slow
    // device a count-based buffer lets travel the finger stopped making
    // decide a flick. Two samples always survive; velocity() needs a pair.
    while (s.samples.length > 2 && e.timeStamp - s.samples[0]!.t > 2 * VELOCITY_WINDOW_MS) s.samples.shift();
  }, [panel]);

  /** Send the released box to `r` — at once if it is already there (a tap, a
   *  release exactly on a detent, a park), on the stylesheet's transition
   *  otherwise, with the backstop armed for a transitionend that never comes. */
  const land = useCallback((s: Gesture, r: { kind: "detent" | "free"; y: number }) => {
    if (!panel) return;
    const p: Pending = r.kind === "free"
      ? { detent: "free", fitH: s.fitH, visibleH: s.capH - r.y }
      : { detent: r.y === 0 && s.fit > 0 ? "cap" : "fit", fitH: s.fitH };
    if (Math.abs(s.y - r.y) < 0.5) { settle(p); return; }
    pending.current = p;
    releaseTranslate(panel, s.y, r.y);
    backstop.current = setTimeout(() => settle(p), SETTLE_BACKSTOP_MS);
  }, [panel, settle]);

  const finish = useCallback((cancelled: boolean) => {
    const s = g.current;
    if (!s || !panel) return;
    g.current = null;
    if (cancelled) {
      // The gesture was taken away, not finished: the pager won a horizontal
      // pan, or the keyboard committed under the held finger. A cancel
      // carries no velocity and, unlike a real release, must NEVER dismiss no
      // matter how far past contentFit the finger had dragged — so it goes
      // through `cancelTarget`, which has no dismiss branch.
      land(s, cancelTarget(s.y, s.fit, s.capH));
      return;
    }
    const r = releaseTarget(s.y, s.moved ? velocity(s.samples) : 0, s.fit, s.capH);
    if (r.kind === "dismiss") {
      // The box stays where the finger let go; the exit keyframes run on
      // `transform` from there. Restore the transition property so nothing
      // is left suppressed on an element that is about to unmount anyway —
      // but FLUSH first: the last move's hold (transition none + translate)
      // may not have reached a style recalc yet, because a flick's final move
      // and its release land in the same task, and restoring the property
      // before that recalc starts a 200ms translate transition from the last
      // RENDERED value toward the held one, underneath the exit (with a
      // same-frame press/move/release the box eases down from the cap while
      // sliding out). A lift arriving mid-exit finds a parked target with
      // the box's own visible height, so it rides the pane rather than
      // easing anywhere.
      void panel.offsetHeight;
      panel.style.transitionProperty = "";
      pending.current = { detent: "free", fitH: s.fitH, visibleH: s.capH - s.y };
      onDismiss();
      return;
    }
    land(s, r);
  }, [panel, land, onDismiss]);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(false);
  }, [finish]);
  const onPointerCancel = useCallback((e: ReactPointerEvent) => {
    if (g.current && e.pointerId === g.current.id) finish(true);
  }, [finish]);

  // The keyboard commits under a held finger, or while a snap is easing.
  //
  // BEFORE the commit, because the release must be computed against the
  // geometry the finger was working in: `restTranslate` reports 0 while a
  // gesture is live, so a lift that found the finger down would ease the box
  // to the cap underneath it. Cancelling first turns the gesture into a
  // pending snap (or a park) — never a dismiss — and the lift-follow's own
  // handlers (registered on `document` after this one: usePanelDrag is called
  // before the lift-follow effect in PanelWindow, and this listener
  // re-registers only when `panel` or `settle` changes — `settle` follows
  // `kind`, which every host passes as a literal, so in practice only when
  // the panel mounts) then measure and retarget THAT.
  //
  // AFTER, re-arm the settle backstop: the lift-follow has just restarted the
  // translate transition toward a NEW target, so the snap's remaining travel
  // is a fresh animation and the original timer would fire part-way through
  // it, dropping the held box early.
  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; });
  useEffect(() => {
    if (!panel) return;
    const doc = panel.ownerDocument;
    const onLift = (e: Event) => {
      const lifted = e.target as Node | null;
      if (!lifted || !lifted.contains(panel)) return; // some other host's lift
      const phase = (e as CustomEvent<KbLiftDetail>).detail?.phase;
      if (phase === "before") { if (g.current) finishRef.current(true); return; }
      if (phase !== "after") return;
      const p = pending.current;
      if (!p || !backstop.current) return;
      clearTimeout(backstop.current);
      backstop.current = setTimeout(() => settle(p), SETTLE_BACKSTOP_MS);
    };
    doc.addEventListener(KB_LIFT_EVENT, onLift);
    return () => doc.removeEventListener(KB_LIFT_EVENT, onLift);
  }, [panel, settle]);
  /* eslint-enable react-hooks/immutability */

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}
