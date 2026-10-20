// The sentinel transition table. Pure core, injected
// history — every arrow in the table is a named test. Run:
//   node --test app/lib/chrome/pageBackSentinel.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createPageBackSentinel, type HistoryLike } from "./pageBackSentinelCore.ts";

function fakeHistory() {
  const ops: string[] = [];
  // Is the CURRENT top entry ours? Starts FALSE (the launch entry is not),
  // and push() flips it true — faithful enough for the one-step tests; the
  // register-time adoption branch (5c-r) reads it, so the old static default
  // would have silently rerouted every test through adoption. Pops are the
  // test's job via setMark (this fake has no entry stack — browserHistory
  // below does).
  let mark = false;
  const h: HistoryLike = {
    push: () => { ops.push("push"); mark = true; },
    back: () => ops.push("back"),
    hasMark: () => mark,
  };
  return { h, ops, setMark: (v: boolean) => { mark = v; } };
}

function browserHistory() {
  // A truthful little browser: an entry stack, an index, and QUEUED
  // traversals — pushState is synchronous, back() is not. That asymmetry is
  // exactly where the 5c-r checkpoint's recorded hypothesis lived, and where
  // the review killed it.
  const entries: Array<{ mark: boolean }> = [{ mark: false }]; // launch
  let i = 0;
  const ops: string[] = [];
  let queued = 0;
  const h: HistoryLike = {
    push: () => { ops.push("push"); entries.splice(i + 1); entries.push({ mark: true }); i += 1; },
    back: () => { ops.push("back"); queued += 1; },
    hasMark: () => entries[i]!.mark,
  };
  /** Execute ONE queued traversal; returns the landed entry's state for the
   *  test to feed onPopstate — the browser's async pop, made explicit. */
  const completeBack = () => {
    if (queued === 0) throw new Error("no traversal queued");
    queued -= 1;
    i -= 1;
    return entries[i]!.mark ? { __bbBack: true } : null;
  };
  /** The user's own Back: immediate pop (no queue — the gesture IS the
   *  traversal), returns the landed state to feed onPopstate. */
  const userBack = () => { i -= 1; return entries[i]!.mark ? { __bbBack: true } : null; };
  return { h, ops, entries, completeBack, userBack, current: () => i };
}

// A manual stand-in for the core's `defer` seam: collects deferred fns
// instead of scheduling a real timer, so a test controls exactly when a
// release's consume runs (`flush()`) — or never runs it at all, to prove a
// cancel actually happened rather than merely racing a real setTimeout.
function fakeDefer() {
  const pending: Array<() => void> = [];
  const defer = (fn: () => void) => {
    pending.push(fn);
    return () => {
      const i = pending.indexOf(fn);
      if (i !== -1) pending.splice(i, 1);
    };
  };
  const flush = () => {
    const toRun = pending.splice(0, pending.length);
    for (const fn of toRun) fn();
  };
  return { defer, flush };
}

test("arm on first page, single entry for a second page", () => {
  const { h, ops } = fakeHistory();
  const { defer, flush } = fakeDefer();
  const s = createPageBackSentinel(h, () => true, defer);
  const r1 = s.register();
  const r2 = s.register();
  assert.deepEqual(ops, ["push"], "one sentinel entry no matter how many pages");
  r2(); // a stacked page closes by UI — pages remain, entry stays
  assert.deepEqual(ops, ["push"]);
  r1(); // last page closes by UI — schedules the consume
  flush(); // …which now actually runs it
  assert.deepEqual(ops, ["push", "back"]);
  s.onPopstate(null); // the back() we caused arrives — must be swallowed
  assert.deepEqual(ops, ["push", "back"], "self-inflicted popstate is not a dismissal");
});

test("system back dismisses the top layer and re-arms while pages remain", () => {
  const { h, ops } = fakeHistory();
  let dismissed = 0;
  const s = createPageBackSentinel(h, () => { dismissed += 1; return true; });
  s.register();
  s.register();
  s.onPopstate(null); // user pressed back: entry popped by the BROWSER
  assert.equal(dismissed, 1, "top layer got the close request");
  assert.deepEqual(ops, ["push", "push"], "re-armed — a page is still open");
});

test("back on the last page: dismiss, then the unmount unregister must NOT double-back", () => {
  const { h, ops } = fakeHistory();
  const { defer, flush } = fakeDefer();
  const s = createPageBackSentinel(h, () => true, defer);
  const release = s.register();
  s.onPopstate(null);   // browser popped the entry; dismiss() closes the page…
  release();            // …whose unmount cleanup schedules the consume AFTER dismissal
  flush();               // …which now actually runs it
  // React commits the unmount after dismiss() returns, so the machine re-armed
  // while pages was still 1; the release then schedules a consume for that
  // entry, which flush() runs. Net: the history ends where it started, and no
  // popstate escapes to the app.
  assert.deepEqual(ops, ["push", "push", "back"]);
  s.onPopstate(null);   // the consuming back arrives
  const before = ops.length;
  s.onPopstate(null);   // any further popstate is not ours
  assert.equal(ops.length, before, "disarmed: no pushes, no backs");
});

test("back with a dialog above the page closes the dialog, page count unchanged", () => {
  const { h, ops } = fakeHistory();
  const s = createPageBackSentinel(h, () => true); // dismiss() hits the dialog's layer
  s.register();
  s.onPopstate(null);
  assert.deepEqual(ops, ["push", "push"], "page still open → re-armed");
});

test("forward-button re-entry into a stale sentinel entry bounces out", () => {
  const { h, ops } = fakeHistory();
  const { defer, flush } = fakeDefer();
  const s = createPageBackSentinel(h, () => true, defer);
  const release = s.register();
  release(); // UI close: schedules the consume
  flush();    // …which now runs it: push, back
  s.onPopstate(null); // consume
  s.onPopstate({ __bbBack: true }); // user pressed FORWARD into our entry
  assert.deepEqual(ops, ["push", "back", "back"], "bounced straight back out");
  s.onPopstate(null); // the bounce's popstate — swallowed
  assert.deepEqual(ops, ["push", "back", "back"]);
});

test("a dismiss that synchronously releases must not fire a second back()", () => {
  // The inversion (dismiss() before armed=false) makes the release inside
  // dismiss() see armed=true with pages 0 and emit a back() that pops a REAL
  // entry — navigating the user away. This is the mutation the other tests
  // cannot catch.
  const { h, ops } = fakeHistory();
  let release: (() => void) | null = null;
  const s = createPageBackSentinel(h, () => { release?.(); return true; });
  release = s.register();
  s.onPopstate(null); // user's Back: dismiss() synchronously releases the page
  assert.deepEqual(ops, ["push"], "no back() — the entry was already popped by the browser");
  const before = ops.length;
  s.onPopstate(null);
  assert.equal(ops.length, before, "fully disarmed after the sync-release dismissal");
});

test("StrictMode double-mount is idempotent", () => {
  // React double-invokes mount effects —
  // register → release → register, all SYNCHRONOUS. A release path that called
  // h.back() immediately would race the browser's async processing of
  // it against the remount's fresh push() — and lose, leaving the machine
  // armed while its entry was already gone. Back on the next real press would
  // then exit the site.
  const { h, ops } = fakeHistory();
  const { defer, flush } = fakeDefer();
  let dismissed = 0;
  const s = createPageBackSentinel(h, () => { dismissed += 1; return true; }, defer);
  const r1 = s.register();
  r1(); // StrictMode's synchronous mount → unmount…
  const r2 = s.register(); // …→ remount, all before any deferred fn runs
  assert.deepEqual(ops, ["push"], "one entry — the pending consume was canceled, not raced");
  s.onPopstate(null); // the machine is still correctly armed
  assert.equal(dismissed, 1, "still dismisses");
  assert.deepEqual(ops, ["push", "push"], "re-armed — the remounted page is still open");
  r2();
  flush();
  assert.deepEqual(ops, ["push", "push", "back"], "exactly one back for the final release");
});

test("user back during a pending consume", () => {
  const { h, ops } = fakeHistory();
  const { defer, flush } = fakeDefer();
  let dismissed = 0;
  const s = createPageBackSentinel(h, () => { dismissed += 1; return true; }, defer);
  const release = s.register();
  release(); // schedules the consume — the entry has NOT been popped yet
  s.onPopstate(null); // the user's own Back beats the deferred consume to it
  assert.equal(dismissed, 0, "the entry was already gone — no layer to dismiss");
  assert.deepEqual(ops, ["push"], "no back() — nothing left for the deferred consume to pop");
  flush(); // the canceled consume must not fire late
  assert.deepEqual(ops, ["push"], "canceled — flush runs nothing");
  s.onPopstate(null); // a further popstate is not ours
  assert.deepEqual(ops, ["push"]);
});

test("a navigation-buried sentinel is never consumed", () => {
  // A same-document Next
  // navigation from inside an open page-window (e.g. a Link in the card
  // body) pushes the router's entry ON TOP of our armed sentinel. If the
  // page then unmounts, a naive deferred consume would call back() and pop
  // the ROUTER's entry — silently undoing the user's navigation.
  const { h, ops, setMark } = fakeHistory();
  const { defer, flush } = fakeDefer();
  const s = createPageBackSentinel(h, () => true, defer);
  const release = s.register();
  setMark(false); // a same-document navigation buried our entry
  release(); // schedules the consume
  flush(); // …which must see the buried entry and back off, not back()
  assert.deepEqual(ops, ["push"], "no back() — that would pop the ROUTER's entry");
  // The user later backs onto the ghost sentinel entry with nothing open:
  // the EXISTING forward/landed-on-marker bounce branch self-removes it.
  s.onPopstate({ __bbBack: true });
  assert.deepEqual(ops, ["push", "back"], "the existing bounce branch cleans up the ghost");
});

test("register adopts a stale marked entry instead of stacking another", () => {
  // A reload (or anything else) that lands with our marked entry CURRENT
  // and a fresh machine: the first open arms on the existing entry.
  const { h, ops, setMark } = fakeHistory();
  let dismissed = 0;
  let release: (() => void) | null = null;
  // Dismiss releases synchronously (the flushSync-unmount shape) so the test
  // sees adoption alone, without the async-unmount re-arm churn on top.
  const s = createPageBackSentinel(h, () => { dismissed += 1; release?.(); return true; });
  setMark(true); // the current entry already carries the mark
  release = s.register();
  assert.deepEqual(ops, [], "no push — the entry on top is already ours");
  s.onPopstate(null); // the user's Back pops the adopted entry
  assert.equal(dismissed, 1, "an adopted arm dismisses exactly like a pushed one");
  assert.deepEqual(ops, [], "pages hit 0 inside the dismissal — nothing pushed, nothing to consume");
});

test("re-arm adopts a marked landing instead of pushing on top of it", () => {
  // Two stacked marked entries (a pre-reload ghost under a fresh one): the
  // user's Back lands on the lower MARKED entry with the page still open —
  // re-arming must ride it, not grow the stack by one per Back.
  const { h, ops } = fakeHistory();
  let dismissed = 0;
  const s = createPageBackSentinel(h, () => { dismissed += 1; return true; });
  s.register();
  s.register(); // two pages: the first Back dismisses the top, page count stays > 0
  s.onPopstate({ __bbBack: true }); // landed entry is ALSO ours
  assert.equal(dismissed, 1);
  assert.deepEqual(ops, ["push"], "re-armed by adoption — no second push");
  s.onPopstate(null); // next Back, landing on an unmarked entry this time
  assert.equal(dismissed, 2);
  assert.deepEqual(ops, ["push", "push"], "unmarked landing → re-arm pushes as before");
});

test("reopen during an in-flight consume: pushes fresh, never adopts the doomed entry", () => {
  // The checkpoint's recorded hypothesis — 'a pushState issued while a
  // consuming back() is in flight gets popped by it, leaving the machine
  // armed with no entry' — pinned FALSE against a truthful browser model:
  // pushState is synchronous, the traversal is queued, so the queued pop
  // lands on the PREDECESSOR of the fresh entry (our own stale S1), and the
  // next real Back still closes the card. The adoption branch must not
  // change this: adopting the doomed entry WOULD create armed-with-no-entry,
  // which is why adoption is guarded on !consuming.
  const { h, ops, completeBack, userBack, current } = browserHistory();
  const { defer, flush } = fakeDefer();
  let dismissed = 0;
  const s = createPageBackSentinel(h, () => { dismissed += 1; return true; }, defer);
  const r1 = s.register();            // push S1 → [L, S1], current S1
  r1();
  flush();                            // consume runs: back() QUEUED, not yet executed
  const r2 = s.register();            // reopen while the traversal is in flight
  assert.deepEqual(ops, ["push", "back", "push"], "consuming guard: fresh push, no adoption");
  s.onPopstate(completeBack());       // the queued pop lands on stale S1 — swallowed
  assert.equal(dismissed, 0);
  assert.equal(current(), 1, "current entry is the stale-but-ours first entry");
  s.onPopstate(userBack());           // the user's real Back
  assert.equal(dismissed, 1, "the card gets the close request — the site is never exited");
  // The dismissal's unmount lands after the handler re-armed (pages was
  // still 1), so the machine re-pushed and the release consumes that fresh
  // entry — the documented push+back churn, invisible to the user.
  r2();
  flush();
  assert.deepEqual(ops, ["push", "back", "push", "push", "back"]);
  s.onPopstate(completeBack());       // the churn's consuming pop — swallowed
  assert.equal(dismissed, 1);
  assert.equal(current(), 0, "history ends at the launch entry, exactly once");
});
