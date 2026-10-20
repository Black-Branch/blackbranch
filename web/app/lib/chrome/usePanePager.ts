"use client";

// The pager's DOM host — wires the pure pager machine (panePager.ts) to a real
// scroll-snap scroller. This file owns none of the arithmetic (that's
// panePager.ts) and none of the physics (native scroll-snap owns that) — only
// getting real DOM events into the machine and the machine's decisions back
// onto the DOM: attaching scroll/scrollend once per enabled/key-set,
// rAF-throttling the tick read, the external re-sync (activeKey changed by
// something other than a swipe — a tab click, a deep link — must snap the
// scroller silently, never through a visible hot band), the rotation re-sync
// (ResizeObserver), and `requestPane`/`mounted` for the caller (ChatSidebar).
//
// Load-bearing (panePager.ts's own comments): the
// quiet-timer fallback settles on whatever `tick()` last recorded, which is
// only ever as current as the LAST tick. So the rAF throttle below reads
// `scrollLeft`/`clientWidth` FRESH, INSIDE the rAF callback, at dispatch
// time — never captured at `scroll`-event time — so the machine's
// `lastProgress` is at most one frame stale at any possible settle.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPagerMachine, inMountWindow, progressOf, SLIDE_MS, slideEase, type PagerMachine } from "./panePager.ts";

/** What the tween tells its owner about how it ended — see `startSlide`. */
export type SlideHooks = {
  /** The landing frame. `moved`: the final write changed `scrollLeft`, so its
   *  scroll event is still in flight and arrives next frame. */
  onLand?: (moved: boolean) => void;
  /** The tween yielded — to native input, or to the returned cancel. */
  onAbort?: () => void;
};

export type UsePanePagerOpts<K extends string> = {
  keys: readonly K[];
  activeKey: K;
  enabled: boolean;
  onCommit: (k: K) => void;
  onHotChange?: (hot: boolean) => void;
};

export type UsePanePagerResult<K extends string> = {
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Fractional pane position while a gesture is hot; `undefined` at rest
   *  (settled) — the committed tab/contentTab is the source of truth then. */
  progress: number | undefined;
  /** Programmatic pane switch (a tab click, not a swipe). Reduced motion or
   *  `enabled: false` commits directly with no scroll at all. */
  requestPane: (k: K) => void;
  /** Whether pane `k` should be in the DOM right now: the active pane always,
   *  plus — mid-gesture — any pane within the approach-mount window. */
  mounted: (k: K) => boolean;
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** A pane's snap-point offset. */
function paneLeft(idx: number, clientWidth: number): number {
  return idx * clientWidth;
}

/** `Element.prototype.scrollTo` may be missing in jsdom (and older WebViews);
 *  fall back to a direct `scrollLeft` assignment when it is absent. */
function scrollToPane(el: HTMLDivElement, left: number, behavior: ScrollBehavior): void {
  if (typeof el.scrollTo === "function") {
    el.scrollTo({ left, behavior });
  } else {
    el.scrollLeft = left;
  }
}

/** The click slide — a house rAF tween (SLIDE_MS, ease-out) instead of the
 *  UA's untunable `behavior: "smooth"` (~2× slower per pane).
 *  Every per-frame `scrollLeft` write fires a real `scroll` event, so the
 *  machine's ticks and the band's progress flow exactly as they would under UA
 *  smooth. The SETTLE does not: each per-frame write is its own instant
 *  scroll and fires its own `scrollend` one frame later (Chrome and Firefox
 *  alike), so where UA smooth has ONE scrollend per slide this tween has a
 *  dozen — each of which would commit a different pane mid-flight.
 *  The tween therefore owns its settle through `hooks`: the machine is told
 *  when a slide begins (its scrollends are ignored), lands (settle once), or
 *  yields (the user's own release settles). Aborts the moment anything ELSE
 *  moves the scroller (|actual − written| > 1: the user grabbed it, or a
 *  resync snapped) — native input must always win over a programmatic tween.
 *  Returns a cancel function. */
/** @test-only exported for direct unit tests with an injected clock (the
 *  house rAF stub passes timestamp 0, so the tween ignores rAF timestamps and
 *  keeps its own clock — injectable here, `performance.now` in production);
 *  production's only caller is `requestPane` below, in this same file.
 *
 *  The tween SUSPENDS scroll-snap for its 200ms. `snap-mandatory` re-snaps
 *  every programmatic `scrollLeft` write back to the nearest snap point, so a
 *  mid-tween position never sticks — the read-back differs from what was
 *  written, the takeover guard fires, and the pane never moves at all (tab
 *  taps would be DEAD on real snap containers while every jsdom test stays
 *  green). The inline override is restored
 *  on every exit path — landing (exactly on a snap position, so re-enabling
 *  causes no jump), external takeover, and cancel — so a user gesture that
 *  interrupts the tween releases under normal snap physics. */
export function startSlide(
  el: HTMLDivElement,
  to: number,
  now: () => number = () => performance.now(),
  hooks: SlideHooks = {},
): () => void {
  const from = el.scrollLeft;
  const start = now();
  let raf = 0;
  let lastWritten = from;
  const prevSnap = el.style.scrollSnapType;
  el.style.scrollSnapType = "none";
  let restored = false;
  const restoreSnap = () => {
    if (restored) return;
    restored = true;
    el.style.scrollSnapType = prevSnap;
  };
  // Exactly one of onLand/onAbort fires, once — `restored` doubles as the
  // "already ended" latch, so a cancel after the landing reports nothing.
  const step = () => {
    if (Math.abs(el.scrollLeft - lastWritten) > 1) { restoreSnap(); hooks.onAbort?.(); return; } // something else took over
    const t = (now() - start) / SLIDE_MS;
    const before = el.scrollLeft;
    lastWritten = from + (to - from) * slideEase(t);
    el.scrollLeft = lastWritten;
    if (t < 1) { raf = requestAnimationFrame(step); return; }
    restoreSnap();
    // Read back, don't assume: a write the engine rounds to the same
    // position fires no scroll event, and the machine must not wait for one.
    hooks.onLand?.(el.scrollLeft !== before);
  };
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    if (restored) return;
    restoreSnap();
    hooks.onAbort?.();
  };
}

export function usePanePager<K extends string>({
  keys, activeKey, enabled, onCommit, onHotChange,
}: UsePanePagerOpts<K>): UsePanePagerResult<K> {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState<number | undefined>(undefined);

  // Re-wire only when the SET of keys changes, not on every render a caller
  // maps inline (the same discipline Sections.tsx's `keySig` follows).
  const keySig = keys.join("|");

  // Latest-value refs so the machine's own callbacks (created once per
  // enabled/keySig in effect A) never need `keys`/`activeKey`/`onCommit`/
  // `onHotChange` in their deps — mirrors Sections.tsx's `applyRef`. Written
  // in an effect, never during render (react-hooks/refs; same discipline
  // exclusiveOpen.ts's `closeRef` uses) — a render can be thrown away under
  // concurrent rendering, and a ref write must not depend on it committing.
  //
  // These are LAYOUT effects, declared ABOVE effects A and B, and both facts
  // are load-bearing. React runs every layout effect (in declaration order)
  // before any passive one, so a `keysRef` written passively is still the
  // PREVIOUS render's list while effect B — a layout effect — is resyncing.
  // The bug that reaches: on a commit where the key set AND `activeKey` change
  // together (MatrixView's first channel tap in mode 1 — keys 1→3, directory→
  // timeline), `resync` does `keysRef.current.indexOf(activeKey)` against the
  // OLD one-key list, gets -1, and silently returns. Nothing retries: effect A
  // does not resync, and the only other path is effect C's ResizeObserver
  // initial delivery — which does not exist at all where `ResizeObserver` is
  // undefined. The row simply never leaves the directory pane.
  const keysRef = useRef(keys);
  useLayoutEffect(() => { keysRef.current = keys; }, [keys]);
  // Only effect C (the ResizeObserver rotation re-sync, an async callback)
  // reads this — effect B below reads `activeKey` straight from its own
  // render closure, which is already current for that commit.
  const activeKeyRef = useRef(activeKey);
  useLayoutEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  const onCommitRef = useRef(onCommit);
  useLayoutEffect(() => { onCommitRef.current = onCommit; }, [onCommit]);
  const onHotChangeRef = useRef(onHotChange);
  useLayoutEffect(() => { onHotChangeRef.current = onHotChange; }, [onHotChange]);

  const machineRef = useRef<PagerMachine | null>(null);
  // The one in-flight click slide's cancel fn (startSlide). A new click, a
  // resync, or teardown cancels it — exactly one tween may drive the scroller.
  const slideCancelRef = useRef<(() => void) | null>(null);
  const cancelSlide = useCallback(() => {
    slideCancelRef.current?.();
    slideCancelRef.current = null;
  }, []);

  // Effect A: attach scroll/scrollend and stand up the machine, once per
  // enabled/keySig.
  //
  // A LAYOUT effect, declared ABOVE effect B. As a passive effect it would run
  // AFTER B, so on the very first commit where the pager becomes enabled the
  // machine would not exist yet when B resynced — `machineRef.current?.
  // programmatic()` a no-op on a `?.`, and the trailing `scroll` from that
  // instant snap would arrive at a freshly-built machine as a REAL gesture tick:
  // hot, a band that tracks nothing, and a settle that commits a pane nobody
  // swiped to. Standing the machine up first makes the programmatic mark
  // always land.
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = scrollerRef.current;
    if (!el) return;

    const machine = createPagerMachine({
      count: () => keysRef.current.length,
      onHot: (hot) => { onHotChangeRef.current?.(hot); },
      onProgress: (p) => { setProgress(p); },
      onSettle: (index) => {
        // Same event task as the commit — React batches the rest-state flip
        // (`progress` → undefined) together with `onCommit`, so the landed
        // pane never sees a mounted-gap frame.
        setProgress(undefined);
        const k = keysRef.current[index];
        if (k !== undefined) onCommitRef.current(k);
      },
    });
    machineRef.current = machine;

    const read = (): number => {
      const width = el.clientWidth;
      if (width <= 0) return 0;
      return progressOf(el.scrollLeft, width, keysRef.current.length);
    };

    // rAF-throttled: one read per frame, and the read happens INSIDE the
    // callback — see the file header for why that must stay true.
    let rafHandle: number | null = null;
    const handleScroll = () => {
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        machine.tick(read());
      });
    };
    const handleScrollEnd = () => { machine.end(read()); };

    el.addEventListener("scroll", handleScroll, { passive: true });
    // `scrollend` is recent Baseline — the machine's quiet timer (armed on
    // every tick, unconditionally) is the universal fallback either way.
    const supportsScrollEnd = typeof window !== "undefined" && "onscrollend" in window;
    if (supportsScrollEnd) el.addEventListener("scrollend", handleScrollEnd);

    return () => {
      cancelSlide();
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      el.removeEventListener("scroll", handleScroll);
      if (supportsScrollEnd) el.removeEventListener("scrollend", handleScrollEnd);
      // Close out hot state BEFORE disposing — a gesture can be mid-flight
      // when `enabled` flips false or the key set changes (the host's
      // `narrow && !split` can flip on rotation mid-gesture). No more scroll
      // events will ever arrive to clear it once the listeners are gone, so
      // without this `progress` sticks at its last value forever and a
      // stray onHotChange(true) is never followed by onHotChange(false) —
      // which the reveal-swipe would read as a permanently revealed bar.
      if (machine.state().hot) onHotChangeRef.current?.(false);
      setProgress(undefined);
      machine.dispose();
      machineRef.current = null;
    };
  }, [enabled, keySig, cancelSlide]);

  // The silent re-sync: snap the scroller to `key`'s pane WITHOUT ever going
  // hot, because it fires for a change the pager itself didn't drive (a tab
  // click, a deep link, a rotation). `machine.programmatic()` marks the one
  // tick this scrollTo produces as consumed rather than a gesture.
  const resync = useCallback((key: K) => {
    const el = scrollerRef.current;
    if (!el) return;
    const idx = keysRef.current.indexOf(key);
    if (idx < 0) return;
    const width = el.clientWidth;
    const currentIdx = width > 0 ? Math.round(el.scrollLeft / width) : 0;
    if (currentIdx === idx) return;
    // A resync that actually MOVES the scroller cancels any gesture in flight.
    // `programmatic()` owns that close-out ENTIRELY on the machine side — the
    // pending quiet timer AND the `onHot(false)` that pairs the gesture's
    // `onHot(true)`. It is deliberately not split with this file: `hot` is
    // machine state, and a host that emitted its own `onHot(false)` while the
    // machine still believed it was hot would desync the two — the next genuine
    // swipe would then never emit `onHot(true)` (the machine thought it already
    // had) and its settle would emit a second, unpaired `onHot(false)`.
    // `progress` is the one half this file must still do, because it is
    // hook state the machine cannot reach: left defined, it keeps Sections'
    // indicator pinned to a finger position that no longer means anything.
    // Read `hot` BEFORE `programmatic()` — that call is what clears it.
    const machine = machineRef.current;
    if (machine?.state().hot) setProgress(undefined);
    cancelSlide(); // an instant re-sync always beats an in-flight click slide
    machine?.programmatic();
    scrollToPane(el, paneLeft(idx, width), "instant");
  }, [cancelSlide]);

  // Effect B: external re-sync — `activeKey` (or the key set) changed.
  // useLayoutEffect so the snap lands before paint, never as a visible jump.
  // Reads `activeKey` straight from this render's closure — already current,
  // no ref needed. Guarded on `enabled`, like A and C: a disabled pager owns
  // no gesture handling, so it must not reach into the DOM either — this is
  // a decision, not an oversight left over from before A/C's own guards.
  useLayoutEffect(() => {
    if (!enabled) return;
    resync(activeKey);
  }, [activeKey, keySig, enabled, resync]);

  // Effect C: rotation re-sync — the pane width changed under an unmoved
  // `activeKey` (every pane's snap-point offset moved with it). Fires from an
  // async ResizeObserver callback, so it needs the ref for a current key.
  useEffect(() => {
    if (!enabled) return;
    const el = scrollerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { resync(activeKeyRef.current); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled, keySig, resync]);

  const requestPane = useCallback((k: K) => {
    if (!enabled || prefersReducedMotion()) {
      onCommitRef.current(k);
      return;
    }
    const el = scrollerRef.current;
    const idx = keysRef.current.indexOf(k);
    if (!el || idx < 0) {
      onCommitRef.current(k);
      return;
    }
    // The house tween, not UA smooth — see startSlide. Ticks (effect A) still
    // drive the band; the SETTLE is the tween's own, handed to the machine
    // through the hooks, because every tween frame fires a scrollend of its
    // own and effect A's listener must not commit on any of them.
    cancelSlide();
    const machine = machineRef.current;
    machine?.slideBegin();
    const readNow = () => progressOf(el.scrollLeft, el.clientWidth, keysRef.current.length);
    slideCancelRef.current = startSlide(el, paneLeft(idx, el.clientWidth), undefined, {
      onLand: (moved) => { slideCancelRef.current = null; machine?.slideLand(readNow(), moved); },
      onAbort: () => { slideCancelRef.current = null; machine?.slideAbort(); },
    });
  }, [enabled, cancelSlide]);

  const mounted = useCallback((k: K) => {
    if (progress === undefined) return k === activeKey;
    if (k === activeKey) return true;
    const idx = keysRef.current.indexOf(k);
    return idx >= 0 && inMountWindow(idx, progress);
  }, [progress, activeKey]);

  return { scrollerRef, progress, requestPane, mounted };
}
