// web/app/components/chrome/Bar.tsx
"use client";

// Bar — a panel's top or bottom strip, exactly one token tall
// (--chrome-top-h / --chrome-bottom-h, globals.css :root). One component and
// one token keep every panel's bars the same height, so side-by-side panels
// line up by construction.
//
// In FLOW at rest — a top-anchored panel (Matrix, news) keeps its header
// where it is. "Hidden" is one distance: the bar pulls its own
// height out of the flow with a negative edge margin (chrome.css), animated,
// so the content follows the bar's edge as it leaves. "Overlay" (desktop
// auto-hide) parks the bar past the edge the same way and slides it back on
// pointer proximity (coordinate-driven, the effect below), its own hover,
// keyboard focus, or a state-driven `revealed`. A hidden bar is inert; an
// overlay bar never is — a keyboard user tabbing into it is what reveals it.
//
// A slot handed nothing renders no lane: `leading={cond && <X/>}` passes
// `false` when the control is withheld, and a lane rendered for it would leave
// the bar's own .5rem gap sitting where the control was.
//
// No className: nothing outside chrome may put a floor on a bar. Consumer
// CSS hooks are `[data-bar="<name>"]` (the fold setting, the folded-pill
// inset). Growth is opt-in: a descendant carrying `data-chrome-grow`
// switches a bottom bar to `height: auto`.
import { useCallback, useEffect, useRef, useState, type FocusEventHandler, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { Band } from "./Band";

export type BarProps = {
  slot: "top" | "bottom";
  /** Stable name for consumer CSS hooks: `[data-bar="chat-top"]`. */
  name?: string;
  /** Out of the flow and off the panel's edge — animated, inert. The bar's whole height is the distance. */
  hidden?: boolean;
  /** Desktop auto-hide: parked past the edge, revealed by proximity / hover / focus. Never inert. */
  overlay?: boolean;
  /** In flow and visually covered by an opaque layer in front (the chat top
   *  bar behind the video column while the keyboard is up). No geometry
   *  change — inert + aria-hidden only, so the covered controls can't be
   *  tabbed or read as invisible targets. Distinct from `hidden`,
   *  which pulls the bar out by its own height. */
  occluded?: boolean;
  /** Force an overlay bar shown (state-driven reveals — the composer while focused). */
  revealed?: boolean;
  /** Fires with the bar's own coordinate-proximity signal (`nearEdge`) — and
   *  ONLY that — whenever it changes while the bar is active overlay
   *  (`overlay && !hidden`); a final `false` when that stops being true, from
   *  the same cleanup that resets `nearEdge` itself. **Overlay bars only** —
   *  never called for a non-overlay bar, not even once, not even `false`.
   *
   *  This deliberately NEVER incorporates the `revealed` prop. Reporting
   *  `revealed || nearEdge` would latch once a host echoes the value back
   *  into `revealed` (exactly what the composer bar does): the OR stays true,
   *  `nearEdge` releasing can no longer change it, the callback never fires
   *  `false`, and the bar sticks open. Only the signal Bar itself OWNS is safe
   *  to hand back, so feeding this callback into `revealed` (as ChatSidebar's
   *  composer bar does) cannot latch.
   *
   *  For a host with something else to keep in sync with "is the pointer
   *  proximity-holding this bar open" (ChatSidebar's message list
   *  translating up under a revealed composer) without
   *  duplicating the proximity mechanism, which stays entirely inside Bar.
   *  Does NOT cover the bar's own CSS `:hover` / `:has(:focus-visible)`
   *  reveal, or the `revealed` prop's own true/false — a host that needs
   *  either of those too keeps using the onMouseEnter/onMouseLeave/
   *  onFocusCapture/onBlurCapture props below, unchanged, alongside this
   *  one, and ORs every signal it tracks together rather than letting any
   *  one of them unilaterally close what another is holding open. */
  onRevealChange?: (nearEdge: boolean) => void;
  /** Pointer-driven reveals stand down: proximity no longer shows the bar and
   *  `onRevealChange` reports false while this holds. `revealed` (a host's
   *  state-driven reveal — the composer while focused) still shows it. The
   *  chat sidebar passes this while a window is open over the pane, so the
   *  typing bar does not slide up under the mod panel as the pointer works
   *  near the bottom edge. */
  standDown?: boolean;
  /** Paint the Console band across the bar; a Sections inside cuts the hole. */
  band?: boolean;
  /** A CSS background value (a token). Omitted = transparent; the panel shows through. */
  background?: string;
  /** The shared seam shade below a top bar. Default on for top bars; the video frame's top bar turns it off. */
  seam?: boolean;
  leading?: ReactNode;
  center?: ReactNode;
  trailing?: ReactNode;
  ref?: Ref<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onFocusCapture?: FocusEventHandler<HTMLDivElement>;
  onBlurCapture?: FocusEventHandler<HTMLDivElement>;
};

export function Bar({
  slot, name, hidden = false, overlay = false, occluded = false, revealed = false, onRevealChange, standDown = false, band = false, background,
  seam = slot === "top", leading, center, trailing, ref,
  onMouseEnter, onMouseLeave, onFocusCapture, onBlurCapture,
}: BarProps) {
  const state = hidden ? "hidden" : overlay ? "overlay" : undefined;

  // Proximity reveal, coordinate-driven. A hover zone element at the host's
  // edge would sit ON TOP of the host's own content (eating clicks on, say,
  // the radio card's controls in theatre), and revealing the bar would move
  // it out from under the pointer, park the bar, and re-arm the zone — an
  // oscillation. So there is no element at all: `nearEdge` is computed from
  // raw pointer coordinates against the HOST's own rect, the same host the CSS
  // park/reveal resolves against via `offsetParent`, so the two can never
  // disagree about where the edge is.
  //
  // Hysteresis (48px arms, 96px releases): a single threshold would flip
  // `nearEdge` back and forth right at the boundary as the pointer sits near
  // the edge. Widening only the "leave" side means once revealed, the pointer
  // has to retreat twice as far before the bar parks again.
  //
  // Known gap: the player (StreamPlayerArea.tsx) is a CROSS-ORIGIN iframe,
  // and a browser delivers NO `pointermove` to the parent document while the
  // cursor sits inside one. Proximity ARMING therefore only works where the
  // parent still sees the pointer at all — the letterbox/pillarbox margins
  // around the video, the page's own gutters, and the bar itself once
  // revealed (it paints above the iframe at z 30, so its own `:hover` keeps
  // it open there regardless of this effect). The arming gap over the
  // video's own interior is ACCEPTED: there is no parent-visible signal to
  // arm on inside a cross-origin frame, short of `pointer-events: none` on
  // the video, which is not this component's call to make. What is fixed is
  // the OTHER half — a bar revealed right before the pointer wanders onto
  // the iframe would otherwise stick open forever, since events simply stop.
  // `pointerout` still fires on the way in (`onOut` below), so parking on
  // that is deliberate, not just damage control: settling on the video is
  // exactly the moment chrome should retract anyway.
  const [nearEdge, setNearEdge] = useState(false);
  const selfRef = useRef<HTMLDivElement | null>(null);

  // A ref, not a dependency, for `onRevealChange` itself: depending on it
  // directly in an effect would re-fire on every render that hands a fresh
  // inline function, even with no real state change — the opposite of
  // "fires when the state CHANGES". No dependency array (runs after every
  // render) and declared BEFORE both effects below that read it, so within
  // any commit where more than one of them runs, the ref is already current.
  const onRevealChangeRef = useRef(onRevealChange);
  useEffect(() => { onRevealChangeRef.current = onRevealChange; });

  useEffect(() => {
    // Overlay is desktop-only by construction (barVisibility.ts:
    // `overlay: !narrow && …`), so this listener is never attached on a
    // phone. No listener is also no synchronous setState here to clear a
    // stale `nearEdge` — react-hooks/set-state-in-effect refuses that
    // pattern (cascading renders on every dep change) — so a stale value is
    // suppressed at the READ site below instead: `nearEdge` only reaches
    // `data-revealed` while this same guard holds. The cleanup below
    // still clears the state itself once the guard closes, for the window
    // between then and the next render.
    if (!(overlay && !hidden)) return;
    const el = selfRef.current;
    if (!el) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // The bar's own containing block — the same one the CSS `position:
        // absolute` park/reveal resolves against, so "near the edge" can never
        // mean two different edges to the two mechanisms.
        const host = el.offsetParent as HTMLElement | null;
        if (!host) return;
        const r = host.getBoundingClientRect();
        const edge = slot === "top" ? r.top : r.bottom;
        const dist = slot === "top" ? e.clientY - edge : edge - e.clientY;
        const inHost = e.clientX >= r.left && e.clientX <= r.right;
        // 48px arms the reveal; leaving takes 96px —
        // the hysteresis that kills the reveal/park oscillation. `dist` goes
        // NEGATIVE once the pointer is PAST the host's edge entirely; a little
        // of that is still "near" (the page gutter, the 12px gap between two
        // panels, the sliver beyond a still-parked bar), so the lower bound is
        // 24px — beyond it the pointer is over a NEIGHBOUR: the dock sits
        // directly under the attached video in desktop compact,
        // and without the bound a pointer anywhere over the dock would hold the
        // video's bottom bar open while a pointer over the video revealed the
        // dock's row. "Over the revealed bar itself" is a small POSITIVE dist
        // and stays open on the bar's own `:hover` regardless of anything
        // here. `inHost` is what keeps this a horizontal band rather than a
        // full-width strip: without it, a pointer over the CHAT panel beside
        // the video (same Y range) would arm the video's bar too.
        setNearEdge((prev) => inHost && dist >= -24 && dist <= (prev ? 96 : 48));
      });
    };
    // Crossing from the parent document into the iframe still fires
    // `pointerout` on the parent chain, with `relatedTarget` set to the
    // iframe element; leaving the window entirely gives `relatedTarget`
    // null. Both mean "the pointer just left everywhere this effect can see
    // it" — park on either, rather than freezing `nearEdge` at whatever it
    // last was, which would stick the bar open.
    const onOut = (e: PointerEvent) => {
      // A tag-name check, not `instanceof HTMLIFrameElement`: `relatedTarget`
      // is always an Element or null here, and comparing by tag avoids
      // depending on which realm's element-constructor identity happens to
      // be in scope (irrelevant in a browser, where `window` IS the global
      // scope, but this file's own jsdom test harness is proof that isn't a
      // safe assumption everywhere this could run).
      const to = e.relatedTarget as HTMLElement | null;
      if (!to || to.tagName === "IFRAME") setNearEdge(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerout", onOut);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerout", onOut);
      if (raf) cancelAnimationFrame(raf);
      // react-hooks/set-state-in-effect flags a synchronous setState in
      // the effect BODY, not in its cleanup — this is lint-clean where the
      // early-return above deliberately is not. Only registered once the
      // listeners actually attached, so this fires exactly when the guard
      // that just closed had something to clear: a later re-arm (overlay
      // returning true with no intervening pointermove — e.g. Alt+R
      // re-opening theatre right after exiting it from the bar itself)
      // starts from a real `false` instead of a stale `true`.
      setNearEdge(false);
      // Report the release from HERE too, not only from the
      // nearEdge-watching effect below. If `overlay`/`hidden` change in the
      // SAME transition that ends proximity (the gate closing), that other
      // effect's own guard reads the NEW overlay/hidden and swallows the
      // nearEdge→false transition before it can report anything — see its
      // comment. This cleanup only ever runs once the listeners actually
      // attached, so it can never fire for a bar that was never active
      // overlay, matching "never for a non-overlay bar" exactly the same
      // way `setNearEdge(false)` above does.
      onRevealChangeRef.current?.(false);
    };
  }, [overlay, hidden, slot]);

  // Reports `nearEdge`'s OWN transitions — and ONLY `nearEdge`, never
  // `revealed` — while the bar is active overlay. See the prop's docblock
  // for why: reporting `revealed || nearEdge` means that once
  // a host (ChatSidebar) echoes that value back into `revealed`, the OR
  // latches permanently true and `nearEdge` releasing stops being visible
  // to anyone. Depending on raw `nearEdge` instead
  // of a value that can itself be polluted by an echoed prop is what makes
  // that latch impossible.
  useEffect(() => {
    // Never for a non-overlay bar — not even once, not even `false`: a host
    // that only cares about overlay bars should see no calls at all, rather
    // than filtering a stream of `false`s from bars it never asked about.
    if (!(overlay && !hidden)) return;
    // `standDown` masks the signal at the READ, never resets `nearEdge` itself
    // (set-state-in-effect); the host hears a false the moment it applies and
    // the real value again when it lifts, with no pointer event needed.
    onRevealChangeRef.current?.(nearEdge && !standDown);
  }, [overlay, hidden, nearEdge, standDown]);

  // Recreated only when `ref` itself changes (`useCallback`, not a fresh
  // closure every render): a stable identity means React attaches this once
  // instead of detaching (calling it with `null`) and reattaching on every
  // Bar render. A churning identity is a hazard for the callback-ref branch
  // it's there to support — a caller handing a function ref would see
  // attach/detach noise it never asked for.
  const setRefs = useCallback((node: HTMLDivElement | null) => {
    // Both are object refs everywhere this codebase calls Bar; the
    // callback form still covers a caller that hands a function ref instead.
    selfRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
  }, [ref]);

  const slots = (
    <>
      {leading != null && leading !== false && <div className="chrome-bar-lead">{leading}</div>}
      <div className="chrome-bar-center">{center}</div>
      {trailing != null && trailing !== false && <div className="chrome-bar-trail">{trailing}</div>}
    </>
  );
  return (
    <div
      ref={setRefs}
      className={`chrome-bar chrome-bar-${slot}`}
      data-bar={name}
      data-state={state}
      data-revealed={revealed || (overlay && !hidden && nearEdge && !standDown) || undefined}
      data-seam={seam || undefined}
      inert={hidden || occluded}
      aria-hidden={hidden || occluded || undefined}
      style={background ? { background } : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      {band ? <Band>{slots}</Band> : slots}
    </div>
  );
}
