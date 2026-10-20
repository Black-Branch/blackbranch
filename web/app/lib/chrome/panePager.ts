// The pager's pure core. It is a
// nested native scroll-snap pager, deliberately NOT a hand-rolled gesture
// engine — native scroll owns the physics (snap points, axis-locking against
// each pane's own vertical scroller, per-gesture scroll-target selection,
// rubber-banding). This file owns none of that. It owns only the arithmetic
// a scroll-snap host needs and cannot get from the DOM for free: turning
// `scrollLeft` into a fractional pane index, deciding which committed index a
// settle lands on, deciding which panes are close enough to warrant a mount
// (the widened registry mount contract — approach-mount within one pane of
// the viewport), and the hot/settle state machine that gates when `progress`
// is allowed to drive the tab-bar indicator versus when the committed
// tab/contentTab is the source of truth. The DOM host (usePanePager.ts) feeds
// this machine real `scroll`/`scrollend` events (with a scroll-quiescence
// timer as the `scrollend` fallback, since Baseline support is recent) and
// reads back hot/progress/settle to drive `Sections`' `progress` prop and the
// tab registry's widened mount rule.

/** How many panes wide a settle's neighbour must be mounted (approach-mount):
 *  the widened registry mount contract. Strict `<` — a pane exactly
 *  MOUNT_WINDOW away is still a pass-through candidate, not a mount one.
 *
 *  @test-only production applies this through `inMountWindow` just below, in
 *  this same file — nothing outside reads the number. It is exported so
 *  panePager.test.ts can assert the strict-`<` boundary AGAINST the constant
 *  (`inMountWindow(2, 0.75) === false`, `MOUNT_WINDOW === 1.25`) instead of
 *  re-spelling 1.25, which is how a threshold and its test drift apart. */
export const MOUNT_WINDOW = 1.25;

/** `scrollLeft / paneWidth`, clamped to a valid fractional pane index
 *  `[0, count - 1]`. `paneWidth <= 0` (not yet laid out) reads as pane 0
 *  rather than dividing by zero or going negative. */
export function progressOf(scrollLeft: number, paneWidth: number, count: number): number {
  if (paneWidth <= 0) return 0;
  const max = Math.max(0, count - 1);
  const raw = scrollLeft / paneWidth;
  if (raw < 0) return 0;
  if (raw > max) return max;
  return raw;
}

/** The committed pane index a settle lands on: nearest integer, clamped into
 *  range. Shared by both settle paths below (`end()` and the quiet-timer
 *  fallback) so a real `scrollend` and a debounced one settle identically.
 *
 *  @test-only its production caller is `settle()` in this same file; the DOM
 *  host reads the already-resolved index off `onSettle`. Exported so
 *  panePager.test.ts can pin the rounding and the clamp directly, rather than
 *  inferring them from which key a machine happened to commit. */
export function settleIndex(progress: number, count: number): number {
  const max = Math.max(0, count - 1);
  const rounded = Math.round(progress);
  if (rounded < 0) return 0;
  if (rounded > max) return max;
  return rounded;
}

/** Is pane `i` within the approach-mount window of the current `progress`? */
export function inMountWindow(i: number, progress: number): boolean {
  return Math.abs(i - progress) < MOUNT_WINDOW;
}

/** Programmatic slide duration (a tab click's pane change). The UA's own
 *  `behavior: "smooth"` takes ~400–500ms for a full pane and cannot be tuned —
 *  too sluggish — so clicks run this house tween instead.
 *  Finger-release snapping stays native physics and is untouched by this. */
export const SLIDE_MS = 200;

/** The slide's easing — ease-out cubic: fast start (the snappiness), gentle
 *  landing (no visible stop). Clamped and monotonic over [0, 1]. */
export function slideEase(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return 1 - Math.pow(1 - c, 3);
}

export type PagerMachine = {
  /** A scroll tick at fractional position `p`. */
  tick(p: number): void;
  /** A settle signal (real `scrollend` or the quiet-timer fallback) at `p`. */
  end(p: number): void;
  /** Mark the NEXT tick as code-driven (a `scrollTo` re-sync), not a gesture —
   *  consumed by exactly that one tick, so it must not flip the machine hot.
   *  Also CANCELS the gesture in flight: it drops any pending quiet timer
   *  and, if the machine was hot, closes that out (`onHot(false)`, no commit).
   *  See the implementation for the stale-settle and the `onHot` desync this
   *  closes. */
  programmatic(): void;
  /** A click slide (the host's per-frame `scrollLeft` tween) is starting.
   *  While sliding, `end()` and the quiet timer are IGNORED: in Chrome and
   *  Firefox alike, every per-frame write is its own
   *  instant scroll and fires its own scroll + scrollend pair one frame
   *  later, so a 200ms tween delivers a dozen `end()`s and would commit a
   *  different pane on each (jitter, and on a slow device a resync of an
   *  intermediate commit snaps the tween back to the wrong pane). Ticks still
   *  flow, so the band and `progress` follow the slide exactly as they follow
   *  a finger. */
  slideBegin(): void;
  /** The tween's landing frame: settle ONCE at `p`. `moved` is whether the
   *  final write changed `scrollLeft` — if it did, its scroll event is still
   *  in flight and arrives NEXT frame, so that one tick is swallowed (else
   *  it would re-hot the machine and the quiet timer would commit a second
   *  time); a write that changed nothing fires nothing, and swallowing would
   *  eat the user's next gesture's first tick instead. */
  slideLand(p: number, moved: boolean): void;
  /** The tween yielded to native input mid-flight: stop owning the settle,
   *  commit nothing — the user's own release settles under native physics. */
  slideAbort(): void;
  /** Clears the pending quiet timer and makes all further events no-ops. */
  dispose(): void;
  state(): { hot: boolean };
};

export type PagerOpts = {
  count: () => number;
  onHot(hot: boolean): void;
  onProgress(p: number): void;
  onSettle(index: number): void;
  quietMs?: number;
  /** Timer seam for the tests (deterministic fire) — the production host
   *  doesn't pass one, it gets the real setTimeout/clearTimeout default. */
  timers?: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void };
};

/** The hot/settle machine. `tick` while hot forwards `progress` to the
 *  tab-bar indicator; a settle (real `scrollend` or, since it's recent
 *  Baseline, the quiet-timer fallback) commits a pane index and hands
 *  `progress` back to the committed tab/contentTab. A `programmatic()`
 *  re-sync (folded pill, arm/close, deep link) must not register as a
 *  gesture — its one resulting tick is swallowed instead of going hot. */
export function createPagerMachine(opts: PagerOpts): PagerMachine {
  const quietMs = opts.quietMs ?? 120;
  const timers =
    opts.timers ??
    {
      set: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clear: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
    };

  let hot = false;
  let pendingProgrammatic = false;
  // A click slide in flight — see `slideBegin` on the interface. Ticks are
  // ordinary while this is set; only the two settle paths defer to the tween.
  let sliding = false;
  // The quiet-timer fallback settles on THIS, not on a fresh read of scroll
  // position at fire time — it is only ever as current as the last `tick()`
  // call. That's fine for the real host: `tick()` is the thing that would
  // have to be current anyway (it's the only place `scrollLeft` reaches this
  // module), so as long as the host keeps ticking on every scroll frame
  // right up to `scrollend` — never throttling or dropping the LAST one
  // before the pointer/wheel event that stops the scroll — `lastProgress` is
  // still the right answer when the timer fires. A host that drops trailing
  // ticks (e.g. rAF-throttles and skips a frame right before the gesture
  // ends) would settle one frame stale.
  let lastProgress = 0;
  let timerHandle: unknown = null;
  let disposed = false;

  function clearTimer(): void {
    if (timerHandle !== null) {
      timers.clear(timerHandle);
      timerHandle = null;
    }
  }

  function settle(p: number): void {
    clearTimer();
    hot = false;
    opts.onHot(false);
    opts.onSettle(settleIndex(p, opts.count()));
  }

  function restartTimer(): void {
    clearTimer();
    timerHandle = timers.set(() => {
      timerHandle = null;
      // Fires with whatever `tick()` last recorded — see the `lastProgress`
      // declaration above for why that's the right value, and what a host
      // must not do (drop the trailing tick) for it to stay right.
      settle(lastProgress);
    }, quietMs);
  }

  function tick(p: number): void {
    if (disposed) return;
    if (pendingProgrammatic) {
      pendingProgrammatic = false;
      return;
    }
    lastProgress = p;
    if (!hot) {
      hot = true;
      opts.onHot(true);
    }
    opts.onProgress(p);
    // No quiet timer under a slide: a single slow frame (> quietMs) would
    // otherwise settle mid-flight — the wrong-pane landing by another door.
    if (!sliding) restartTimer();
  }

  function end(p: number): void {
    if (disposed) return;
    if (!hot) return; // the instant sync's own scrollend
    if (sliding) return; // the tween's per-frame scrollend — the landing settles
    settle(p);
  }

  function slideBegin(): void {
    if (disposed) return;
    clearTimer(); // a slide starting under a hot gesture's timer takes over its settle
    sliding = true;
  }

  function slideLand(p: number, moved: boolean): void {
    if (disposed) return;
    sliding = false;
    // `settle` closes the hot pairing the slide's first tick opened. A slide
    // whose frames never ticked (cancelled before its first scroll event
    // was delivered) has nothing to close — but it still landed, so commit.
    if (hot) settle(p);
    else opts.onSettle(settleIndex(p, opts.count()));
    if (moved) pendingProgrammatic = true;
  }

  function slideAbort(): void {
    if (disposed) return;
    sliding = false;
  }

  function programmatic(): void {
    if (disposed) return;
    // A code-driven reposition CANCELS the gesture bookkeeping in flight,
    // timer included. Without this clear there is a real race, narrow but
    // reachable:
    //   tick(0.4)          → hot, quiet timer armed on lastProgress = 0.4
    //   programmatic()     → the resync's tick will be swallowed…
    //   (swallowed tick)   → …and, because `tick` early-returns, it does NOT
    //                        re-arm the timer — but it does not clear the OLD
    //                        one either
    //   ~120ms later       → the stale timer fires and settles on 0.4,
    //                        committing a pane the scroller has since left
    // and that commit REVERTS whatever fresh state drove the resync in the
    // first place (in MatrixView: the flag write from openRoom or a back
    // arrow). The settle would be silent — the right pane is on screen and the
    // flags say otherwise.
    // The swallow itself must stay non-re-arming (`tick`'s early return above),
    // or this clear would just be undone one tick later.
    clearTimer();
    // EXACTLY-ONCE `onHot` PAIRING, owned here. Cancelling the timer means
    // no settle will arrive for the interrupted gesture — and a settle was the
    // only thing that dropped `hot` and emitted `onHot(false)`. Leaving `hot`
    // true here desyncs the machine from reality in a way the NEXT swipe pays
    // for: `tick` sees `hot` already true, so it never emits `onHot(true)`, and
    // that gesture's settle then emits a SECOND, unpaired `onHot(false)` —
    // `[true, false, false]`, and the reveal bar never opens for the
    // follow-up swipe.
    // This close-out deliberately lives in the machine rather than being split
    // with the host: `hot` is machine state, so one source of truth for
    // dropping it is the only way the pairing can be exactly-once. (The host
    // still resets its own `progress` — that is hook state this cannot reach.)
    // It is `settle()` minus the commit: a cancelled gesture must not commit.
    if (hot) {
      hot = false;
      opts.onHot(false);
    }
    sliding = false; // the host cancels the tween on every resync; the machine must agree
    pendingProgrammatic = true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearTimer();
  }

  return {
    tick,
    end,
    programmatic,
    slideBegin,
    slideLand,
    slideAbort,
    dispose,
    state: () => ({ hot }),
  };
}
