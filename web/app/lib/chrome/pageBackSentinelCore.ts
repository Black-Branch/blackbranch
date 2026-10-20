// The page-window back state machine — pure core, injected history. Split out
// of pageBackSentinel.ts so the transition table has a real production
// consumer of its own, not just its test: pageBackSentinel.ts's `sentinel()`
// builds the one live instance from this; pageBackSentinel.test.ts drives it
// directly with fake history.
//
// StrictMode: React double-invokes mount effects — register → release →
// register, all SYNCHRONOUS. A release that called h.back() immediately would
// be processed by the browser ASYNCHRONOUSLY — so the remount's register()
// would already have pushed a fresh entry by the time the in-flight back()
// landed, popping THAT one instead. The machine would end armed=true with its
// entry already gone, and the user's next Back would pop a real entry and exit
// the site. So the consume is deferred (see `defer` below) and a synchronous
// remount can cancel it before it ever reaches the browser — the core must be
// idempotent under setup→cleanup→setup, not just correct in the async-unmount
// ordering.

export type HistoryLike = {
  /** Push the sentinel entry (same URL; current state + MARK). */
  push(): void;
  back(): void;
  /** Is the CURRENT top history entry ours? A same-document navigation from
   *  inside an open page (e.g. a Link in the card body) can bury our entry
   *  under the router's — the deferred consume checks this before ever
   *  calling back(), or it pops the wrong entry. */
  hasMark(): boolean;
};

/** The history-state key that marks a sentinel entry — one source of truth
 *  for both the singleton's push() and this module's own onPopstate check. */
export const MARK = "__bbBack";

/** Does this history-state object carry our MARK? One predicate, referenced
 *  both by the forward-bounce branch below and by the singleton's hasMark()
 *  binding — the two places that need to answer "is this entry ours". */
export function hasMarkState(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[MARK] === true;
}

/** Pure core — exported for the transition-table tests AND for
 *  pageBackSentinel.ts's production singleton.
 *  `defer` is a seam for the tests (deterministic flush instead of a real
 *  timer); the production singleton doesn't pass one, it gets the real
 *  macrotask default below. */
export function createPageBackSentinel(
  h: HistoryLike,
  dismiss: () => boolean,
  defer: (fn: () => void) => () => void = (fn) => {
    const t = setTimeout(fn, 0);
    return () => clearTimeout(t);
  }
) {
  let pages = 0;      // registered page-windows
  let armed = false;  // our entry is the top of history
  let consuming = false; // the next popstate is one we caused
  let cancelConsume: (() => void) | null = null; // a deferred release-consume, pending

  function register(): () => void {
    if (cancelConsume) {
      // A StrictMode remount (or any register that lands before the deferred
      // consume runs): the entry the last release scheduled a back() for is
      // still ours — cancel it instead of racing it. `armed` was never
      // touched by the scheduling, so it is still true and the push guard
      // below correctly skips pushing a second entry.
      cancelConsume();
      cancelConsume = null;
    }
    pages += 1;
    if (pages === 1 && !armed) {
      // Adoption: if the CURRENT entry already carries our mark, arm
      // on it instead of stacking another — a reload that lands on a marked
      // entry, or any corruption that left a ghost on top, self-heals here.
      // NOT while a consume is in flight: consuming=true means our own
      // queued back() is about to pop that very entry — adopting it would
      // recreate the armed-with-no-entry state this machine exists to
      // prevent; pushing a fresh entry gives the traversal something stale
      // to land on instead (a benign forward ghost).
      if (h.hasMark() && !consuming) {
        armed = true;
      } else {
        h.push();
        armed = true;
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pages -= 1;
      if (pages === 0 && armed) {
        // UI close (✕ / Escape / programmatic): consume the entry, or the
        // user would need TWO Backs to leave after closing normally.
        // Deferred, not immediate: `armed` stays true until the consume
        // actually runs, because the entry still exists until then — a
        // synchronous re-register (StrictMode) can still cancel this.
        cancelConsume = defer(() => {
          if (!h.hasMark()) {
            // A same-document navigation from inside the page (e.g. a Link
            // in the card body) buries our entry; back() here would pop the
            // ROUTER's entry and undo the user's navigation. Leave the buried
            // sentinel as a ghost entry: the existing forward/landed-on-
            // marker bounce branch below self-removes it when the user
            // later backs onto it.
            cancelConsume = null;
            armed = false;
            return;
          }
          cancelConsume = null;
          armed = false;
          consuming = true;
          h.back();
        });
      }
    };
  }

  function onPopstate(state: unknown): void {
    if (cancelConsume) {
      // The user's own Back beat our deferred consume to the entry: it is
      // already gone (pages is already 0, or this popstate wouldn't exist),
      // so the deferred back() must not fire late — there is nothing left
      // for it to pop.
      cancelConsume();
      cancelConsume = null;
      armed = false;
      return;
    }
    if (consuming) {
      consuming = false;
      return;
    }
    if (armed) {
      // The user's Back popped our entry: a close request.
      // Disarm BEFORE dismissing: a dismiss handler that synchronously
      // unregisters (flushSync unmount, or a consumer releasing inside its
      // close callback) must see armed=false, or its release fires a second
      // back() that pops a REAL entry. In the ordinary async-unmount path
      // the unregister lands after this function re-arms, and consumes the
      // fresh entry — push+back churn, invisible to the user.
      armed = false;
      dismiss();
      if (pages > 0) {
        // Re-arm adoption (5c-r): landing on an entry that is ALREADY marked
        // (stacked stale sentinels — e.g. a pre-reload mark under a fresh
        // one) re-arms on it instead of growing the stack by one per Back.
        if (!hasMarkState(state)) h.push();
        armed = true;
      }
      return;
    }
    // Forward-button re-entry into a stale sentinel entry with nothing open
    // (also the self-clean path for a navigation-buried ghost — see above).
    if (hasMarkState(state) && pages === 0) {
      consuming = true;
      h.back();
    }
  }

  return {
    register,
    onPopstate,
    /** Live machine snapshot — read by the ?backdebug=1 overlay (5c-r), so
     *  a failing DEVICE can report what the machine believed at swipe time
     *  instead of leaving the mechanism to hypothesis. */
    state: () => ({ pages, armed, consuming, pendingConsume: cancelConsume !== null }),
  };
}
