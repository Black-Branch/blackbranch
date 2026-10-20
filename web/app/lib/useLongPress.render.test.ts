// Behavioural tests for useLongPress — the hook is RUN, not source-scanned.
//
// Swiping the side of the screen as a "back" gesture to close the keyboard
// must not trigger the touch-and-hold options on mobile. The menu that opens
// carries mod delete, so that would be a destructive control reachable by a
// system gesture.

import test from "node:test";
import assert from "node:assert/strict";
import { mountHook, touchEvent } from "./testDom.ts";
import { useLongPress } from "./useLongPress.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Comfortably longer than the 20ms delay the tests arm, without being slow. */
const AFTER_DELAY = 60;

/** Mount the hook with a short delay and a counter for how often it fired. */
async function armed(opts: { delay?: number; tolerance?: number } = {}) {
  const fired: { count: number } = { count: 0 };
  const h = await mountHook(() =>
    useLongPress(() => { fired.count += 1; }, opts.delay ?? 20, opts.tolerance)
  );
  return { h, fired };
}

// ── The D-1 mechanism ────────────────────────────────────────────────────────
//
// When the OS or browser claims a touch sequence for itself — an edge "back"
// swipe, a scroll handoff, a system gesture — it dispatches `touchcancel` and
// then stops sending `touchmove` and `touchend` for that sequence entirely.
//
// So the movement guard never gets to run: an edge swipe begins with the finger
// almost stationary (the OS is still deciding whether it owns the gesture), any
// touchmove that does arrive is inside the 10px tolerance, and once the OS takes
// over there are no further events at all. The 350ms timer is left armed with
// nothing able to cancel it, and it fires the menu into a gesture the user
// aimed at the operating system.
//
// `useAnchoredChat.ts:185` already listens for touchcancel for exactly this
// reason. This hook simply never did.
test("a touch sequence the BROWSER cancels must not fire the long press (D-1)", async () => {
  const { h, fired } = await armed();

  await h.act(() => { h.current.onTouchStart(touchEvent(2, 400)); });   // finger at the edge
  await h.act(() => { h.current.onTouchCancel(); });                    // OS claims the gesture
  await sleep(AFTER_DELAY);

  assert.equal(
    fired.count, 0,
    "the long press fired on a sequence the browser had already cancelled — an OS edge " +
    "swipe delivers touchcancel and then NO further touchmove/touchend, so nothing else " +
    "can stop the timer"
  );
  await h.unmount();
});

test("a cancelled sequence leaves no armed timer behind for the NEXT press", async () => {
  const { h, fired } = await armed();

  await h.act(() => { h.current.onTouchStart(touchEvent(2, 400)); });
  await h.act(() => { h.current.onTouchCancel(); });
  // A fresh, deliberate press immediately afterwards must fire exactly once —
  // not twice from a leaked timer, and not zero times from a poisoned ref.
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await sleep(AFTER_DELAY);

  assert.equal(fired.count, 1, "the following deliberate press must fire exactly once");
  await h.unmount();
});

// ── Guard the blast radius: the ordinary paths must be untouched ─────────────

test("a deliberate stationary press still fires", async () => {
  const { h, fired } = await armed();
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await sleep(AFTER_DELAY);
  assert.equal(fired.count, 1, "the normal long press must still work");
  await h.unmount();
});

test("a press that drifts beyond the tolerance still cancels", async () => {
  const { h, fired } = await armed();
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await h.act(() => { h.current.onTouchMove(touchEvent(200, 460)); });  // 60px > 10px
  await sleep(AFTER_DELAY);
  assert.equal(fired.count, 0, "the movement guard must still cancel");
  await h.unmount();
});

test("lifting before the delay still cancels", async () => {
  const { h, fired } = await armed();
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await h.act(() => { h.current.onTouchEnd(touchEvent(200, 400)); });
  await sleep(AFTER_DELAY);
  assert.equal(fired.count, 0, "a quick tap must not become a long press");
  await h.unmount();
});

// The release-swallowing contract. A long press that FIRED must preventDefault
// its own touchend, or the browser's compatibility mouse events land under the
// finger and close the menu instantly.
test("a FIRED long press still swallows its own release", async () => {
  const { h, fired } = await armed();
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await sleep(AFTER_DELAY);
  assert.equal(fired.count, 1, "setup: the press must have fired");

  const release = touchEvent(200, 400);
  await h.act(() => { h.current.onTouchEnd(release); });
  assert.equal(
    release.defaultPrevented, true,
    "a fired long press must preventDefault its touchend, or the synthetic mouse " +
    "sequence closes the menu it just opened"
  );
  await h.unmount();
});

test("a cancelled press does NOT swallow a later ordinary tap's release", async () => {
  const { h } = await armed();
  await h.act(() => { h.current.onTouchStart(touchEvent(200, 400)); });
  await h.act(() => { h.current.onTouchCancel(); });

  const tap = touchEvent(200, 400);
  await h.act(() => { h.current.onTouchEnd(tap); });
  assert.equal(
    tap.defaultPrevented, false,
    "cancelling must clear the fired flag too — otherwise the next tap loses its click"
  );
  await h.unmount();
});
