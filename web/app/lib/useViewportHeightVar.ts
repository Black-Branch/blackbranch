"use client";

// `.ts` extension is REQUIRED here, same rule as useSendDestination.ts: this
// hook is exercised under `node --test` (useViewportHeightVar.render.test.ts),
// which cannot resolve extensionless TypeScript specifiers. safeLocalStorage is
// a leaf module (it imports nothing), so this is the only one needed.
import { useEffect } from "react";
import { lsGet, lsSet } from "./safeLocalStorage.ts";
import { Q_TOUCH_PRIMARY } from "./deviceQueries.ts";
import { raisesKeyboard } from "./keyboardEditable.ts";

// Keep the app shell above the on-screen keyboard.
//
// ── ONE MECHANISM, NO EXCEPTIONS ─────────────────────────────────────────────
// Everywhere — iOS, Firefox, Chromium, browser tabs and installed PWAs alike —
// measure `visualViewport` ourselves, PREDICT on focus, and COMMIT ONCE. The
// meta ships `interactive-widget=resizes-content` (the canonical mode for a
// bottom-composer layout, and Firefox Android's native model): the LAYOUT
// viewport shrinks with the keyboard, so visual == layout, the page cannot be
// panned while typing, and dvh itself follows the keyboard. iOS ignores the meta
// and resizes the visual viewport as it always has — the same measuring code
// serves it.
//
// NO PWA-ONLY EXCEPTION. A Chromium PWA branch that opts into
// `virtualKeyboard.overlaysContent = true` and lets the compositor drive
// `.h-app` through `env(keyboard-inset-height)` returns before the measuring
// path starts, so the installed app runs none of the prediction, none of the
// discrete commit and none of the transition — every keyboard fix would miss
// it. The env() geometry is also documented-broken
// (zouhir.org/blog/virtual-keyboard-api, interop#1016, crbug 493412612: it
// overshoots then corrects, 343 -> 392 -> 343), and shows a ~16px under-lap on
// device.
//
// Nothing may set `overlaysContent`: per spec it OVERRIDES the meta, so
// enabling it silently voids the viewport contract above.
//
// Prediction exists because no platform's resize arrives before the keyboard has
// finished animating (WICG/visual-viewport#79) — but we do not FOLLOW the
// keyboard, so a late or jittery signal costs nothing. See `committedH`.
//
// ── WHY THERE IS A `baseHeight` AND NO `window.innerHeight` ──────────────────
// Measuring relative to `window.innerHeight` assumes the LAYOUT viewport stays
// full-height while the keyboard is up. That holds on some
// browser/`interactive-widget` combinations and not others — and where the
// browser shrinks the layout viewport too, `innerHeight - guess` subtracts a
// keyboard's height from a viewport that ALREADY excludes it, lifting the
// composer roughly a keyboard too far (Firefox overshoots). The same
// assumption makes `keyboardUp()` answer "no" while the keyboard is up, and
// makes the learned height come out as ~0 so it never improves on the seed.
//
// `baseHeight` — the tallest viewport seen while nothing is focused — is a
// stable reference that does not care which viewport the browser chooses to
// resize. Everything below is expressed against it.

// ── The ONE keyboard truth ───────────────────────────────────────────────────
// TWO facts, ONE publisher, ONE notification: whether the keyboard is up, and
// how far it eats into the viewport. A SECOND, parallel detector with its own
// baseline and thresholds driving the bar collapse would fold the bars on a
// different frame than the shell moves (visible flicker) — two state machines
// answering one question.
//
// `inset` is the COMMITTED inset, never the live measurement. It is derived
// from `committedH` — the height this file has decided on — so it inherits the
// discrete-commit property wholesale: one value per keyboard open, changing on
// exactly the frame the shell moves. A consumer that positions itself from this
// number therefore cannot be dragged through the platform's jitter (Chrome
// Android 691 -> 1026 -> 691 on a show, crbug 40924170), because the jitter
// never reaches it.
//
// This is the single scalar the mobile layer architecture is driven by.
// Anything that needs to know where the keyboard is reads it here; a second
// source of truth for that question is the two-detector bug returning.
let kbOpen = false;
let kbInset = 0;
const kbListeners = new Set<() => void>();
/** Set while the soft keyboard is up, and only then — steady state, not a
 *  transient animation marker. See publishKb. */
// Read by chrome/keyboardOwner.ts and chrome/liftToken.ts (who owns the keyboard; whether a
// ceiling token's write must be announced); messageMenu.test.ts asserts the name.
export const KB_OPEN_CLASS = "kb-open";
/** Name of the DOM event useKeyboardLift dispatches on the element it lifts —
 *  bubbling, immediately BEFORE and AFTER every write of K (`detail.phase`),
 *  so a descendant that lays itself out from `--kb-lift` can read its own
 *  geometry on both sides of the change inside one task. PanelWindow's
 *  lift-follow needs exactly that pair to turn the ceiling's one-frame layout
 *  jump into a compositor translate (Window.tsx). Owned here beside
 *  KB_OPEN_CLASS because this module is the ONE keyboard truth and these are
 *  the names of its DOM surfaces; it also sits below useKeyboardLift in the
 *  import graph, which lets the ?kbdebug recorder below listen for it. A
 *  bubbling DOM event rather than a module subscription: a subscriber fires
 *  before React has re-rendered, while the DOM still holds the old K, and
 *  "the write happened between these two calls" is a fact only the writer
 *  can state. */
export const KB_LIFT_EVENT = "bb:kb-lift";
export type KbLiftDetail = { phase: "before" | "after"; k: number };

function publishKb(open: boolean, inset: number): void {
  const px = Math.max(0, Math.round(inset));
  if (open === kbOpen && px === kbInset) return;
  kbOpen = open;
  kbInset = px;
  // Mirrored onto <html> as well as the module state. Two reasons, both real:
  //
  //   1. LAYERING. `useLongPress` is a generic gesture hook and must not import
  //      this module — doing so also broke its node render test, which loads the
  //      hook directly. Reading a class off the root keeps the dependency at
  //      zero while still using ONE source of truth (this function).
  //   2. It makes "is the keyboard up?" inspectable from devtools and from a
  //      screenshot, which is how the last four rounds of this bug were finally
  //      settled.
  //
  document.documentElement.classList.toggle(KB_OPEN_CLASS, open);
  for (const l of kbListeners) l();
}
export function isKeyboardOpen(): boolean {
  return kbOpen;
}
/** How far the keyboard eats into the viewport, in CSS px. 0 when it is down. */
export function keyboardInset(): number {
  return kbInset;
}
export function subscribeKeyboardOpen(cb: () => void): () => void {
  kbListeners.add(cb);
  return () => { kbListeners.delete(cb); };
}

const KB_KEY = "kbHeight";   // last measured keyboard height, per device
const CONFIRM_MS = 500;      // roll back a prediction nothing confirmed
const MIN_KB = 120;          // smaller than this is a toolbar, not a keyboard
const MAX_KB = 420;
const SEED_FRACTION = 0.38;  // of baseHeight, when this device is still unknown
/** Viewport must hold still this long before we accept it as the resting geometry. */
const SETTLE_MS = 140;
/** A settled height within this of where we already are is not worth a second motion. */
const CORRECT_PX = 8;

export function useViewportHeightVar(): void {
  useEffect(() => {
    const mm = window.matchMedia;
    // ONE query, not two ANDed by hand — a touchscreen laptop has a coarse
    // pointer available and must not take this path. See deviceQueries.ts.
    const touchPrimary = !!mm && mm(Q_TOUCH_PRIMARY).matches;
    if (!touchPrimary) return;

    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    // WRITE `height` DIRECTLY — NEVER A CUSTOM PROPERTY ON :root.
    // `root.style.setProperty("--app-vh", …)` is the dominant cost of a choppy
    // keyboard, not the keyboard and not the height. Custom properties
    // INHERIT, so setting one on the root element makes Blink recalculate
    // computed style for every element that inherits it — the entire document
    // — on every frame of the keyboard's travel.
    //
    // Measured (Chrome DevTools, 390x844 mobile emulation, 4x CPU throttle,
    // 12-frame sweep 844->500px, mean frame delta; 10.0ms is the vsync floor):
    //     --app-vh on :root ......... 39.5 / 42.5 / 39.9 / 40.5 ms   (~25fps)
    //     height on html + body ..... 10.0 / 10.0 / 10.0 ms          (= idle)
    //     idle control .............. 10.0 ms
    // and proven by SCOPE, not inference — the same per-frame write costs 10.0ms on
    // a leaf element, 26.1ms on the chat aside (1939 descendants), ~40ms on :root
    // (2121). A control writing a property NO stylesheet reads still cost 30.4ms, so
    // it is invalidation, not evaluation.
    //
    // `@property` does NOT fix this. It makes a custom property interpolable; the
    // inheritance still cascades a full style recalc. Only `inherits: false` scoped
    // to one element is cheap — at which point writing `height` is simpler.
    //
    // Why it hides: on an unthrottled DESKTOP the frame delta is 10.3 vs 10.0 —
    // invisible. The forced style recalc measures 8.09ms vs 0.42ms (~19x); a
    // phone's slower CPU is what turns that into dropped frames. Profile this on
    // a THROTTLED mobile emulation or not at all.
    //
    // And the RESIZE IS FREE. Direct-height resizes html AND body — full layout
    // of a 2121-node document with a 1939-node chat list — at 10.0ms, i.e. idle.
    // Do not contort the architecture to avoid shell reflow at this DOM size.
    //
    // BOTH elements carry `.h-app` (layout.tsx sets it on <html> and <body>), so both
    // are written and both are cleared. Clearing restores the CSS tier — verified on
    // a live page: set 500px -> clear -> computed height back to the `.h-app` value
    // with nothing left in the style attribute.
    const body = document.body;
    const setH = (px: number) => {
      const v = `${Math.round(px)}px`;
      root.style.height = v;
      body.style.height = v;
    };
    const clearH = () => {
      root.style.height = "";
      body.style.height = "";
    };

    // The VirtualKeyboard API handle — DIAGNOSTICS ONLY. It is worth printing
    // in ?kbdebug: comparing what the API claims against what we measure is how
    // the env() tier's under-report shows, and it is the reading that would
    // settle any future overlap question.
    // `overlaysContent` is deliberately NEVER set — leaving it alone is what
    // keeps `interactive-widget=resizes-content` in charge.
    const vk = (navigator as Navigator & {
      virtualKeyboard?: EventTarget & { overlaysContent: boolean; boundingRect: DOMRect };
    }).virtualKeyboard;

    // ONE MECHANISM, EVERY PLATFORM. No exceptions, no per-browser branch.
    //
    // The meta ships `interactive-widget=resizes-content`, so on every Android
    // browser the viewport shrinks by the keyboard's TRUE occlusion (nav-gesture
    // zone included), and iOS has always resized the visual viewport. The
    // measuring path below therefore serves iOS, Firefox and Chromium — tabs and
    // installed PWAs alike — identically.
    //
    // NO PWA-ONLY `env(keyboard-inset-height)` TIER. One that sets
    // `virtualKeyboard.overlaysContent = true` and returns before start() leaves
    // an installed Chromium PWA running none of the prediction, none of the
    // discrete commit and none of the transition — the shell driven straight
    // off env() by the compositor, with no transition on the property,
    // hard-cutting on a signal Chrome is documented to overshoot and correct
    // (343 -> 392 -> 343, crbug 493412612), and showing the same ~16px
    // under-lap Chrome tabs do.
    //
    // Its justification — env() is compositor-published, so nothing arrives
    // late — does not apply: we do not FOLLOW the keyboard at all. We predict
    // on focus, commit once, and the shell PINS — the lifted panels own the
    // motion — so a late signal costs nothing.

    /** The visible box, in layout coordinates. iOS offsets it as well as shrinking it. */
    const measured = () => vv.height + vv.offsetTop;

    // PINCH-ZOOM POISONS EVERY MEASUREMENT. At scale ≠ 1, `vv.height` is the
    // zoomed-in window in layout px — treating it as the viewport would learn a
    // garbage keyboard height and size the shell to a fraction of the screen
    // (a pinch-zoom interaction can strand the composer off-screen after a
    // refresh). While zoomed, this hook stands down entirely — no prediction,
    // no learning, no inline height — and the dvh fallback tier owns the
    // height; a zoomed page is being READ, not typed into.
    const zoomed = () => Math.abs((vv.scale ?? 1) - 1) > 0.01;

    // ── The stable reference ────────────────────────────────────────────────
    let baseHeight = measured();
    /** How much of the viewport the keyboard is currently eating. Diagnostics only. */
    const inset = () => Math.max(0, baseHeight - measured());
    // There is no `keyboardUp()` here: `onFocusIn` asks `committedH !== null`
    // instead. Anything tempted to re-derive "is the keyboard up" from a
    // threshold should read `committedH` or `isKeyboardOpen()` — two answers to
    // one question is what this file exists to prevent.

    // ── State ───────────────────────────────────────────────────────────────
    let raf = 0;
    let predicting = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    /** Debounce that decides when the viewport has stopped moving — see settle(). */
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Recovers a baseline inflated by a toolbar sample — unrelated to settle(). */
    let baseTimer: ReturnType<typeof setTimeout> | null = null;
    /** Is an editable actually focused? Gates LEARNING — see learn(). */
    let focusedEditable = false;
    let running = false;

    // THE HEIGHT WE HAVE COMMITTED THE SHELL TO, or null when the shell is
    // released to CSS. This single variable is what makes the motion discrete.
    //
    // Setting the height on EVERY resize the platform reports during the
    // keyboard's travel reads as "up-pause-up": the shell steps predicted ->
    // partial -> partial -> final, each step a hard cut. That is not fixable by
    // tuning, because the signal being followed is jittery, non-monotonic and
    // unspecified on every browser — Chrome Android reports 691 -> 1026 -> 691
    // on a keyboard show (crbug 40924170) and the VirtualKeyboard API repeats
    // 343 -> 392 -> 343 (crbug 493412612), roughly 2-5 events per transition
    // with duplicates. The `interactive-widget` spec defines WHAT resizes and
    // never the TIMING, and Tab Atkins is explicit that UAs need only be
    // correct once the animation has FINISHED.
    //
    // So we do not follow it. We commit ONCE, animate on our own curve, and
    // look at the platform again only after it has stopped moving.
    let committedH: number | null = null;
    /** Diagnostics only (?kbdebug): how many separate moves this open has cost. */
    let commitCount = 0;

    /**
     * Publish the one truth. Call after ANY state change that could move either
     * fact — never from inside commit()/release(), so a consumer never observes
     * the half-updated pair (open with a stale inset, or vice versa).
     */
    const publishNow = (open: boolean) =>
      publishKb(open, committedH === null ? 0 : baseHeight - committedH);

    /** Commit the keyboard decision. The shell is PINNED — it holds baseHeight
     *  for the whole open: the browser still shrinks the layout viewport per
     *  `interactive-widget=resizes-content`, so the pinned shell's bottom K px
     *  sit under the keyboard, CLIPPED by html's overflow-hidden — and the
     *  panels that host a composer translate up by K (useKeyboardLift) to
     *  compensate. committedH still records the keyboard-derived height because
     *  K = baseHeight − committedH is the one scalar every lifted panel moves
     *  on. The pin write is idempotent and visually a no-op at open time (dvh
     *  still equals baseHeight when focus fires), which is why no height
     *  transition exists.
     *  The WRITTEN value depends on `baseHeight`, but the guard above keys
     *  on `committedH` only — every path that can mutate baseHeight while
     *  committed self-heals (growth is gated on `!focusedEditable` and
     *  `h > baseHeight`, neither of which holds while a genuine keyboard
     *  inset has driven the commit; the downward baseTimer recovery only
     *  runs post-release; orientation re-runs apply()→settle(), which
     *  re-commits), so a stale pin is never actually missed — but a NEW
     *  baseHeight mutation site added while committed must call
     *  `setH(baseHeight)` itself, or this guard will not catch it. */
    const commit = (px: number) => {
      const next = Math.round(px);
      if (committedH === next) return;
      committedH = next;
      commitCount++;
      setH(baseHeight);
      // The pinned shell is K px taller than the layout viewport, and
      // overflow:hidden still makes html/body SCROLL CONTAINERS — the browser
      // scrolls scrollable ancestors to reveal a focused editable, and while
      // pinned that scroll would STICK for the whole open (nothing clamps it
      // back). Zero it on every commit — the settle correction lands here too,
      // so a mispredict window's scroll is undone on the same frame the panels
      // take their corrected K.
      root.scrollTop = 0;
      body.scrollTop = 0;
    };

    /** Hand the height back to CSS. Idempotent — this runs on every toolbar resize. */
    const release = () => {
      if (committedH === null) return;
      committedH = null;
      commitCount = 0;
      clearH();
    };

    const cancelPrediction = () => {
      predicting = false;
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    };

    // LEARN ONLY WHILE AN EDITABLE IS FOCUSED, and only from a SETTLED
    // viewport. A keyboard-sized inset with nothing focused is not a keyboard —
    // it is an inflated baseline (a URL bar hidden when the reference was taken),
    // and writing that to KB_KEY would poison the prediction PER DEVICE.
    // Learning from a settled value additionally means we never record one of
    // Chrome's mid-animation overshoots as this device's keyboard height.
    const learn = (kb: number) => {
      if (!focusedEditable) return;
      const known = Number(lsGet(KB_KEY)) || 0;
      if (Math.abs(kb - known) > 4) lsSet(KB_KEY, String(Math.round(Math.min(kb, MAX_KB))));
    };

    /**
     * The viewport has stopped changing: accept it as the real resting geometry.
     *
     * This is a debounce on the RESTING VALUE, not on the animation's timing —
     * the distinction matters. Timing a heuristic against the platform's cadence
     * would be tuning against behaviour the spec explicitly leaves undefined.
     * Waiting for a signal to stop moving before believing it is just hygiene,
     * and if it settles late nothing visible happens: we are already at roughly
     * the right height, and the correction is suppressed entirely unless it is
     * worth more than CORRECT_PX.
     */
    const settle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (zoomed()) return;
        const now = measured();
        const kb = baseHeight - now;
        if (kb <= MIN_KB) return;   // it left while we waited — the close path owns that
        // ASYMMETRIC, and the asymmetry is the point: the keyboard must never
        // overlap the bottom of the input bar.
        //
        // `committedH` is the decided VISIBLE height — not what the pinned
        // shell shows (it always shows baseHeight) but what every lifted
        // panel's composer sits at the bottom of, K = baseHeight − committedH
        // up from the pinned shell's bottom. If the real viewport (`now`) is
        // SHORTER than committedH, K is UNDERSTATED: the panel hasn't lifted
        // far enough, and the composer sits under the keyboard. That is a
        // correctness failure and must always be corrected, however small.
        // Suppressing it under a tolerance is how a 1-7px overlap becomes
        // permanent.
        //
        // The other direction — the real viewport TALLER than committedH, so K
        // is overstated and the panel has lifted a little further than it
        // needs to — is a cosmetic gap between composer and keyboard, and
        // there CORRECT_PX earns its keep: a pixel or two of drift is not
        // worth a second visible movement.
        if (committedH === null) commit(now);
        else if (now < committedH || now - committedH > CORRECT_PX) commit(now);
        learn(kb);
        // The settle correction moves the shell, so it moves the inset too —
        // openness is unchanged here, only how far.
        publishNow(isKeyboardOpen());
      }, SETTLE_MS);
    };

    // ── Measurement ─────────────────────────────────────────────────────────
    const apply = () => {
      raf = 0;
      if (zoomed()) {
        // Stand down while pinch-zoomed — see `zoomed`. Releasing (rather than
        // freezing) hands the height to dvh, which is the only tier that stays
        // meaningful under zoom.
        cancelPrediction();
        release();
        publishNow(false);
        return;
      }
      const h = measured();

      // Grow the reference whenever the viewport is taller than we have seen
      // WHILE NOTHING IS FOCUSED — that is the keyboard-free state, by
      // definition. Never shrink it in this direction, or the keyboard's own
      // effect would be absorbed into the baseline and the inset would read as
      // zero.
      //
      // The `!focusedEditable` guard matches this file's own header, which
      // defines baseHeight as "the tallest viewport seen WHILE NOTHING IS
      // FOCUSED". Chrome Android is documented to report a spuriously LARGER
      // viewport mid-animation (crbug 40924170: 691 -> 1026 -> 691 on a
      // keyboard show). Unguarded, one such overshoot would permanently inflate
      // the reference; the focus prediction would then be skipped forever and
      // learning would drift. This is the SAME poisoning the toolbar note below
      // describes — a second source of it, and the downward recovery could
      // never clear this one because that recovery is itself gated on
      // `!focusedEditable`.
      if (!focusedEditable && h > baseHeight) baseHeight = h;

      const kb = baseHeight - h;

      if (kb > MIN_KB) {
        // A keyboard-sized inset — and we deliberately DO NOT follow it.
        // A measurement confirms the prediction (so the rollback timer stands
        // down), but the value itself is only believed once it settles.
        cancelPrediction();
        // Nothing has committed yet — a keyboard raised without a focusin we
        // saw, or a re-tap during a dismissal. Move now rather than wait out
        // SETTLE_MS, so this case is never the laggy one.
        if (committedH === null) commit(h);
        settle();
      } else if (!predicting) {
        // NO KEYBOARD IN PLAY → HAND THE HEIGHT BACK TO CSS. A `setH(h)` here
        // would make the shell chase the browser toolbar a frame late on every
        // scroll — Firefox's collapsing URL bar fires `resize` continuously,
        // and the input bar's top border would shimmer as the app shell
        // re-followed it from JS. The `.h-app` fallback (100dvh − keyboard
        // env()) is compositor-animated and toolbar-aware; sub-keyboard deltas
        // are its job, not ours.
        release();
        // Downward recovery for the reference (the other half): a `baseHeight`
        // that only ever grows lets one sample taken with the URL bar hidden
        // inflate it forever — so the keyboard reads as up with no keyboard,
        // the focus prediction is skipped and learning drifts toward
        // toolbar-sized junk. A SMALLER viewport that stays put for a second
        // with nothing focused is the browser's real resting size: adopt it.
        // Its own timer, not settle()'s — different question, different delay,
        // and they can be pending at the same time.
        if (!focusedEditable && kb > 8) {
          if (baseTimer) clearTimeout(baseTimer);
          baseTimer = setTimeout(() => {
            baseTimer = null;
            const now = measured();
            if (!focusedEditable && Math.abs(now - h) < 2 && now < baseHeight) {
              baseHeight = now;
            }
          }, 1000);
        }
      }
      // The one truth, derived from the same state that moved the shell — so
      // the bars fold on the same frame the composer rises, never a different
      // detector's frame. `predicting` counts as open: the bars should fold
      // WITH the prediction lift, not after the browser's late resize.
      publishNow(predicting || kb > MIN_KB);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };

    // ── Prediction ──────────────────────────────────────────────────────────
    // Focus fires on the tap, long before any viewport event, so this is the
    // only way to be right immediately rather than correct ~250ms late.
    //
    // The prediction is KEPT, and the CORRECTION is what is limited. "Predict
    // then correct every frame" produces two-stage motion; "never predict"
    // produces visible lag on Firefox (whose visualViewport is additionally
    // stale until you scroll). Predicting once and correcting only at settle is
    // the shape that has neither: one motion, starting on the tap. On a device
    // whose keyboard height is already learned the settle correction is
    // suppressed by CORRECT_PX and there is exactly ONE movement all the way up.
    function onFocusIn(e: FocusEvent) {
      if (!raisesKeyboard(e.target)) return;
      focusedEditable = true;
      if (zoomed()) return;                   // stand down while pinch-zoomed
      // "Already where we need to be", asked directly rather than inferred from
      // a threshold on a jittery signal.
      //
      // This is NOT what keeps a second keyboard open prompt — both forms
      // behave identically in every case we could construct. A late second
      // open comes from a PER-FRAME CHASE: if on focusout the shell followed the
      // keyboard DOWN, a re-tap would find it halfway to the floor with the
      // prediction suppressed and it would have to climb back reactively. The
      // discrete commit prevents it — the shell holds its height until the
      // keyboard is genuinely gone (see the descent test).
      if (committedH !== null) return;

      // There is ALWAYS a guess: bailing out when nothing had been learned made
      // the first open on any device fully reactive, which is the very lag this
      // removes. The seed deliberately UNDER-estimates — landing a little low
      // settles up by a few pixels, whereas overshooting lifts the composer
      // above the keyboard and drops it back, which reads as a bounce.
      const learned = Number(lsGet(KB_KEY)) || 0;
      const guess = learned >= MIN_KB
        ? learned
        : Math.min(MAX_KB, Math.max(MIN_KB, Math.round(baseHeight * SEED_FRACTION)));

      predicting = true;
      commit(baseHeight - guess);
      publishNow(true);

      if (confirmTimer) clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        // Nothing confirmed it: a hardware keyboard, or a focus that raised
        // none. Leaving the guess would crop the app for no reason.
        if (predicting) { cancelPrediction(); apply(); }
      }, CONFIRM_MS);
    }

    function onFocusOut() {
      focusedEditable = false;
      cancelPrediction();
      schedule();
    }

    function onOrientation() {
      // New geometry entirely — the old reference is meaningless. Re-measure
      // after the rotation settles.
      setTimeout(() => { baseHeight = measured(); apply(); }, 300);
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────
    function start() {
      if (running) return;
      running = true;
      apply();
      vv!.addEventListener("resize", schedule);
      // `scroll` matters as much as `resize`: on iOS it is often the ONLY signal
      // that the keyboard opened.
      vv!.addEventListener("scroll", schedule);
      window.addEventListener("orientationchange", onOrientation);
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);
    }
    function stop() {
      if (!running) return;
      running = false;
      if (raf) cancelAnimationFrame(raf);
      cancelPrediction();
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      if (baseTimer) { clearTimeout(baseTimer); baseTimer = null; }
      committedH = null;
      vv!.removeEventListener("resize", schedule);
      vv!.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", onOrientation);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      clearH();   // hand height back to the env()/dvh chain
      publishKb(false, 0);
    }

    // ── Diagnostics: add ?kbdebug=1 to the URL for a live readout ───────────
    // Three phone/browser combinations have now failed in three different ways
    // (Firefox revert, Firefox back-button close, Chrome-tab under-keyboard),
    // and a screenshot with numbers beats any description. Overlay-only, no
    // behaviour change; pointer-events none so it cannot swallow taps.
    let dbgTimer: ReturnType<typeof setInterval> | null = null;
    let liftListener: ((e: Event) => void) | null = null;
    if (/[?&]kbdebug/.test(location.search)) {
      const box = document.createElement("div");
      box.style.cssText =
        "position:fixed;top:4px;left:4px;z-index:2147483647;background:rgba(0,0,0,.85);" +
        "color:#7CFC00;font:11px/1.5 monospace;padding:6px 8px;pointer-events:none;white-space:pre";
      document.body.appendChild(box);
      // env() cannot be read directly — measure elements sized by it.
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;visibility:hidden;height:env(keyboard-inset-height,0px)";
      document.body.appendChild(probe);
      const safeProbe = document.createElement("div");
      safeProbe.style.cssText = "position:fixed;visibility:hidden;height:env(safe-area-inset-bottom,0px)";
      document.body.appendChild(safeProbe);
      const dvhProbe = document.createElement("div");
      dvhProbe.style.cssText = "position:fixed;visibility:hidden;height:100dvh";
      document.body.appendChild(dvhProbe);
      // ── Window-open RECORDER ─────────────────────────────────────────
      // A panel open that "bounces up and pulls back down" on a device can be
      // clean in emulator traces, and emulation cannot host the suspects — it
      // has neither a virtual keyboard nor a URL bar, and the URL bar is what
      // gives a real phone root-scroll range at all. So record the open ON THE
      // DEVICE: watch for a panel mounting, sample every frame for 700ms, and
      // keep the EXTREMES on screen afterwards so one screenshot settles what a
      // description cannot.
      //   above>0  the panel rose ABOVE its layer (the "flies off" symptom)
      //   hMin/hMax  the panel's height changed mid-open (a freeze mismeasure)
      //   scr      the largest root/layer scroll seen (the focus-scroll suspect)
      //   dK       K moved during the open (a keyboard commit rode the entry)
      let lastOpen = "open —";
      const recordOpen = (panel: HTMLElement) => {
        const layer = panel.parentElement;
        if (!layer) return;
        const t0 = performance.now();
        let above = -1e9, hMin = 1e9, hMax = 0, scr = 0, kMin = keyboardInset(), kMax = kMin;
        const tick = () => {
          const pr = panel.getBoundingClientRect();
          const lr = layer.getBoundingClientRect();
          above = Math.max(above, lr.top - pr.top);
          hMin = Math.min(hMin, pr.height);
          hMax = Math.max(hMax, pr.height);
          scr = Math.max(scr, root.scrollTop, layer.scrollTop, document.body.scrollTop);
          const k = keyboardInset();
          kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
          if (performance.now() - t0 < 700 && panel.isConnected) requestAnimationFrame(tick);
          else lastOpen =
            `open above ${Math.round(above)} h ${Math.round(hMin)}-${Math.round(hMax)}\n` +
            `     scr ${Math.round(scr)} dK ${Math.round(kMax - kMin)} frz ${panel.style.height || "-"}`;
        };
        requestAnimationFrame(tick);
      };
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of Array.from(m.addedNodes)) {
            const el = n as HTMLElement;
            if (el.nodeType === 1 && el.classList?.contains("chrome-window-panel")) recordOpen(el);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      // ── Lift-follow RECORDER ─────────────────────────────────────────
      // Jittery resizing when the keyboard opens over a card/window: a rAF
      // sampler only ever sees main-thread frames, so emulation cannot show a
      // compositor/main-thread desync — record the keyboard-open-with-panel
      // case ON THE DEVICE: from each K write with a panel mounted, sample
      // every frame for 700ms and keep the extremes on screen.
      //   above  the panel's top rose above the video column's bottom (px)
      //   gap    the seam opened between the panel and the composer (px)
      //   rev    direction reversals of the panel's top edge (a jitter)
      //   h#     times the panel's LAYOUT height changed — a per-frame
      //          resize scores ~11 here; the lift-follow allows exactly 1
      //   end    panel top − column bottom at rest (0 = flush at the ceiling)
      //   fr     frames sampled in 700ms (a struggling device drops well
      //          below ~40)
      let lastLift = "lift —";
      const recordLift = (panel: HTMLElement) => {
        const layer = panel.parentElement;
        if (!layer) return;
        const col = document.querySelector(".bb-video-col");
        const t0 = performance.now();
        let above = 0, gap = 0, rev = 0, hchg = 0, fr = 0, prevTop = NaN, prevDir = 0, prevH = panel.offsetHeight, endGap = NaN;
        const tick = () => {
          const pr = panel.getBoundingClientRect();
          const lr = layer.getBoundingClientRect();
          const cb = col ? col.getBoundingClientRect().bottom : -Infinity;
          fr++;
          above = Math.max(above, cb - pr.top);
          gap = Math.max(gap, lr.bottom - pr.bottom);
          if (!Number.isNaN(prevTop)) {
            const dir = Math.sign(pr.top - prevTop);
            if (dir && prevDir && dir !== prevDir) rev++;
            if (dir) prevDir = dir;
          }
          prevTop = pr.top;
          if (panel.offsetHeight !== prevH) { hchg++; prevH = panel.offsetHeight; }
          endGap = col ? pr.top - cb : NaN;
          if (performance.now() - t0 < 700 && panel.isConnected) requestAnimationFrame(tick);
          else lastLift =
            `lift above ${Math.round(above)} gap ${Math.round(gap)} rev ${rev} h# ${hchg}\n` +
            `     end ${Number.isNaN(endGap) ? "-" : Math.round(endGap)} fr ${fr} K ${keyboardInset()}`;
        };
        requestAnimationFrame(tick);
      };
      liftListener = (e: Event) => {
        if ((e as CustomEvent<KbLiftDetail>).detail?.phase !== "after") return;
        const panel = (e.target as Element).querySelector(".chrome-window-panel") as HTMLElement | null;
        if (panel) recordLift(panel);
      };
      document.addEventListener(KB_LIFT_EVENT, liftListener);

      dbgTimer = setInterval(() => {
        // The Chrome-tab under-lap arithmetic needs the shell's REAL height and
        // the API's own rect, not my pixel-squinting on a screenshot: underlap
        // = (shell bottom) − (keyboard top) = shellH − (dvh − kbRect.height −
        // whatever sits below the keyboard). Every operand is printed.
        const shell = document.querySelector(".h-app") as HTMLElement | null;
        const rect = vk?.boundingRect;
        // Window-layer trace (open-flow): the numbers that adjudicate "opened
        // too high / escaped the pane / no animation" from a device
        // screenshot. layT is the layer's K term working (its top offset inside
        // the pane wrapper = --kb-lift), gap the panel-bottom↔seam distance,
        // frz the entry freeze's inline height, act where focus (and so the
        // keyboard) lives. FALLBACK names the body-portal shape — a fallback
        // open on a home-page pane is itself a finding.
        const wp = document.querySelector(".chrome-window-panel") as HTMLElement | null;
        const wl = wp?.closest(".chrome-window-layer") as HTMLElement | null;
        const fb = wp ? null : document.querySelector(".chrome-window-sheet, .chrome-window-page");
        let winLine = "win —";
        if (wp && wl) {
          const pr = wp.getBoundingClientRect();
          const lr = wl.getBoundingClientRect();
          const wr = (wl.parentElement as HTMLElement).getBoundingClientRect();
          winLine =
            `win h ${Math.round(pr.height)} top ${Math.round(pr.top)} gap ${Math.round(lr.bottom - pr.bottom)}\n` +
            `lay T ${Math.round(lr.top - wr.top)} h ${Math.round(lr.height)} frz ${wp.style.height || "-"} act ${document.activeElement?.tagName ?? "-"}`;
        } else if (fb) {
          const fr = fb.getBoundingClientRect();
          winLine = `win FALLBACK(${fb.className.includes("sheet") ? "sheet" : "page"}) h ${Math.round(fr.height)} top ${Math.round(fr.top)} act ${document.activeElement?.tagName ?? "-"}`;
        }
        box.textContent =
          // One path now. `vkApi` says whether this browser even HAS the
          // VirtualKeyboard API, and `standalone` whether this is the installed
          // app — the two facts that used to select a different code path, kept
          // visible so "which path am I on" can never be a mystery again.
          `path measure  vkApi ${vk ? "yes" : "no"}  standalone ${!!window.matchMedia?.("(display-mode: standalone)")?.matches}\n` +
          `vv.h ${vv.height.toFixed(1)}  off ${vv.offsetTop.toFixed(1)}\n` +
          `innerH ${window.innerHeight}  dvh ${dvhProbe.offsetHeight}\n` +
          `base ${baseHeight.toFixed(1)}  inset ${inset().toFixed(1)}\n` +
          `setH ${root.style.height || "(unset)"}  shellH ${shell ? Math.round(shell.getBoundingClientRect().height) : "?"}\n` +
          `env(kb) ${probe.offsetHeight}px  safeB ${safeProbe.offsetHeight}px\n` +
          `vkRect y ${rect ? Math.round(rect.y) : "-"} h ${rect ? Math.round(rect.height) : "-"}\n` +
          `screen ${window.screen.height}  dpr ${window.devicePixelRatio}\n` +
          `scale ${(vv.scale ?? 1).toFixed(2)}  predicting ${predicting}\n` +
          // The commit state. `commits` is the number that matters: ONE per
          // open is the whole point of the design, so a 2 here on a device
          // whose height is already learned means the settle correction is
          // firing when it should have been suppressed by CORRECT_PX.
          // `scroll` makes a root-scroll bug visible from a screenshot:
          // nonzero while committed means the browser scrolled the pinned root
          // to reveal a focused editable and it stuck — commit() must zero it
          // every time (see its body).
          `committed ${committedH ?? "(released)"}  commits ${commitCount}  scroll ${root.scrollTop}\n` +
          // K is what the layer model translates on. It must equal
          // base − committed exactly, and must not move between commits.
          `K ${keyboardInset()}  open ${isKeyboardOpen()}\n` +
          winLine + "\n" + lastOpen + "\n" + lastLift;
      }, 250);
    }
    const stopDbg = () => {
      if (dbgTimer) { clearInterval(dbgTimer); dbgTimer = null; }
      if (liftListener) { document.removeEventListener(KB_LIFT_EVENT, liftListener); liftListener = null; }
    };

    // No Chromium-PWA `env()` branch here (see the ONE MECHANISM note above):
    // one would return before this line, so an installed PWA would run none of
    // the code below. Do not introduce a per-platform branch here without
    // device evidence that this path fails.
    start();
    return () => { stop(); stopDbg(); };
  }, []);
}
