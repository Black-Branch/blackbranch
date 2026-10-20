// Behavioural tests for useAnchoredChat's pause/re-anchor state machine,
// RENDERED not source-scanned — the contract is "does a gesture landing HERE
// flip the state", which only real events against a mounted hook can answer.
//
// What is pinned: a single 8px constant judging both directions means a touch
// fling that decays 20–40px short of the frozen list's end — visually AT the
// bottom, since queued rows don't render while paused — never re-anchors
// ("chat paused won't come back"). And a wheel tick's smooth-scroll tail keeps
// scrolling past the 150 ms window the wheel event opened, so the frames that
// land at the bottom would read as layout noise and Firefox users would sit
// paused at the frozen list's end until they sent a message.
//
// `.ts` extensions are REQUIRED on these imports — `node --test` cannot
// resolve extensionless TypeScript specifiers.

import test from "node:test";
import assert from "node:assert/strict";
import { dom, mountHook } from "./testDom.ts";
import { installResizeObserverStub } from "./testTsx.ts";
import { useAnchoredChat } from "./useAnchoredChat.ts";

// The hook constructs a ResizeObserver at mount; jsdom has none. Module
// scope, before any mount — the installResizeObserverStub precedent.
installResizeObserverStub();

const SCROLL_H = 2000;
const CLIENT_H = 600;

/** Mount the hook with a scroller whose geometry we control. */
async function mountChat() {
  const el = dom.window.document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: SCROLL_H, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: CLIENT_H, configurable: true });
  el.scrollTop = SCROLL_H - CLIENT_H; // start at the bottom
  const items = ["a", "b", "c"];
  const h = await mountHook(() => {
    const r = useAnchoredChat<string>({ items, getKey: (s) => s });
    // Attach the ref DURING render, as JSX would — the hook's listener
    // effects read scrollRef.current at mount-effect time.
    if (!r.scrollRef.current) r.scrollRef.current = el;
    return r;
  });
  /** Put the scroller `dist` px above the bottom and fire onScroll. */
  const scrollTo = (dist: number) =>
    h.act(() => {
      el.scrollTop = SCROLL_H - CLIENT_H - dist;
      h.current.onScroll();
    });
  const touch = (type: "touchstart" | "touchend") =>
    h.act(() => { el.dispatchEvent(new dom.window.Event(type)); });
  /** One mouse-wheel tick; positive deltaY scrolls down, as in the DOM. */
  const wheel = (deltaY: number) =>
    h.act(() => { el.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY })); });
  return { h, el, scrollTo, touch, wheel };
}

/**
 * Take over `performance.now` so a wheel tick's smooth-scroll tail can be placed
 * in time exactly. Starts far past any window a real-clock touch opened, so the
 * only gesture window a test then sees is the one it opens itself.
 */
function fakeClock() {
  const real = performance.now.bind(performance);
  let t = real() + 10_000;
  performance.now = () => t;
  return {
    advance: (ms: number) => { t += ms; },
    restore: () => { performance.now = real; },
  };
}

/** Drag up far from the bottom so the hook pauses (dist 400 ≫ any threshold). */
async function pause(c: Awaited<ReturnType<typeof mountChat>>) {
  await c.touch("touchstart");
  await c.scrollTo(400);
  await c.touch("touchend");
  assert.equal(c.h.current.anchored, false, "precondition: paused after an upward drag");
}

test("a drag landing 30px short of the bottom re-anchors (the lived bug)", async () => {
  const c = await mountChat();
  await pause(c);
  await c.touch("touchstart");
  await c.scrollTo(30); // visually at the bottom; old 8px test said it wasn't
  await c.touch("touchend");
  assert.equal(c.h.current.anchored, true, "paused chat must resume within REANCHOR_PX");
  assert.equal(c.el.scrollTop, SCROLL_H, "re-anchor asserts the true bottom");
  await c.h.unmount();
});

test("a momentum event after finger-lift still re-anchors (fling decay)", async () => {
  const c = await mountChat();
  await pause(c);
  await c.touch("touchstart");
  await c.scrollTo(120);       // finger leaves well above the zone
  await c.touch("touchend");   // opens the momentum window
  await c.scrollTo(40);        // decaying fling's last event lands inside it
  assert.equal(c.h.current.anchored, true, "momentum reaching the zone must resume");
  await c.h.unmount();
});

test("landing above the slack zone stays paused", async () => {
  const c = await mountChat();
  await pause(c);
  await c.touch("touchstart");
  await c.scrollTo(60); // > REANCHOR_PX — still reading scrollback
  await c.touch("touchend");
  assert.equal(c.h.current.anchored, false, "60px up is a reading position, not the bottom");
  await c.h.unmount();
});

test("pause sensitivity did NOT widen — 20px up still pauses (asymmetry pin)", async () => {
  const c = await mountChat();
  assert.equal(c.h.current.anchored, true, "precondition: anchored at mount");
  await c.touch("touchstart");
  await c.scrollTo(20); // > PAUSE_PX(8), < REANCHOR_PX(48): must still PAUSE
  await c.touch("touchend");
  assert.equal(c.h.current.anchored, false,
    "a small upward drag must pause — widening REANCHOR_PX must not deaden PAUSE_PX");
  await c.h.unmount();
});

test("a non-gesture scroll while paused changes nothing (layout noise stays inert)", async () => {
  const c = await mountChat();
  await pause(c);
  // pause() ends on a touchend, which opens the 150ms momentum window — wait
  // it out, or this "non-gesture" scroll would count as fling momentum.
  await c.h.act(async () => { await new Promise((r) => setTimeout(r, 160)); });
  await c.scrollTo(0); // no gesture window open — app-driven write, not the user
  assert.equal(c.h.current.anchored, false,
    "only gestures re-anchor; programmatic writes to the bottom must not");
  await c.h.unmount();
});

test("an upward drag inside the slack zone is NOT snapped back (otherwise the chat fights the reader)", async () => {
  const c = await mountChat();
  assert.equal(c.h.current.anchored, true, "precondition: anchored at mount");
  await c.touch("touchstart");
  await c.scrollTo(15); // > PAUSE_PX: pauses
  assert.equal(c.h.current.anchored, false, "15px up pauses (hair-trigger)");
  await c.scrollTo(30); // still moving UP, inside REANCHOR_PX — prod snapped this back to 0
  assert.equal(c.h.current.anchored, false, "a drag moving AWAY from the bottom must never re-anchor");
  assert.equal(c.el.scrollTop, SCROLL_H - CLIENT_H - 30, "the list stays under the finger — no snap");
  await c.scrollTo(45);
  assert.equal(c.h.current.anchored, false, "still reading");
  await c.touch("touchend");
  assert.equal(c.h.current.anchored, false, "lifting the finger at 45px up is a reading position, not a landing");
  await c.h.unmount();
});

test("a drag that turns back TOWARD the bottom re-anchors once it is inside the slack zone", async () => {
  const c = await mountChat();
  await pause(c);
  await c.touch("touchstart");
  await c.scrollTo(200); // moving down, still far above the zone
  assert.equal(c.h.current.anchored, false, "200px up is not a landing");
  await c.scrollTo(40);  // moving down, inside REANCHOR_PX — this IS the landing
  assert.equal(c.h.current.anchored, true, "moving toward the bottom into the zone resumes");
  assert.equal(c.el.scrollTop, SCROLL_H, "re-anchor asserts the true bottom");
  await c.h.unmount();
});

test("a wheel tick whose smooth-scroll tail outlives the gesture window still re-anchors (Firefox otherwise never returns to live)", async () => {
  const c = await mountChat();
  await pause(c);
  const clock = fakeClock();
  try {
    await c.wheel(100);      // one tick down opens the wheel window at t
    clock.advance(100);
    await c.scrollTo(200);   // tail frame inside the window, still far above the zone
    clock.advance(90);       // t+190: past the window the wheel event opened —
    await c.scrollTo(20);    // Firefox's default 200 ms tail lands here, moving down, inside REANCHOR_PX
    assert.equal(c.h.current.anchored, true, "the tail's landing in the zone is the user's landing");
    assert.equal(c.el.scrollTop, SCROLL_H, "re-anchor asserts the true bottom");
  } finally {
    clock.restore();
  }
  await c.h.unmount();
});

test("the extended wheel window closes when the tail stops — a later programmatic scroll is still noise", async () => {
  const c = await mountChat();
  await pause(c);
  const clock = fakeClock();
  try {
    await c.wheel(100);
    clock.advance(100);
    await c.scrollTo(200);   // last tail frame, above the zone
    clock.advance(151);      // the window the tail extended has now closed
    await c.scrollTo(0);     // an app-driven write to the bottom, not the user
    assert.equal(c.h.current.anchored, false, "only a scroll event within GESTURE_MS of the last tail frame is the user's");
  } finally {
    clock.restore();
  }
  await c.h.unmount();
});

// The scroll keys against the REAL engine. A pure test on a fake element
// proves the arithmetic; it cannot see that a key's scrollTop write fires a
// scroll event with no gesture window open, which onScroll reads as layout
// noise and, while anchored, corrects straight back to the bottom — PgUp would
// do nothing on a live feed. The key must PAUSE the engine first; PgDn landing
// within the re-anchor slack goes back to live through the anchor, as End does.
test("PgUp while anchored pauses the feed instead of being snapped back", async () => {
  const { scrollChatByKey } = await import("./chatScrollKeys.ts");
  const c = await mountChat();
  assert.equal(c.h.current.anchored, true, "precondition: following");
  const before = c.el.scrollTop; // the engine's own bottom assertion (jsdom does not clamp)
  await c.h.act(() => {
    scrollChatByKey(c.el, "PageUp", c.h.current.anchorToBottom, c.h.current.pause);
    c.h.current.onScroll(); // the scroll event the scrollTop write fires
  });
  assert.equal(c.h.current.anchored, false, "a page up means 'I'm reading'");
  assert.ok(c.el.scrollTop < before, `the feed moved up (scrollTop ${c.el.scrollTop}, was ${before})`);
  assert.notEqual(c.el.scrollTop, SCROLL_H, "…and was not corrected back to the bottom");
  await c.h.unmount();
});

test("PgDn landing within the re-anchor slack returns to live through the anchor", async () => {
  const { scrollChatByKey } = await import("./chatScrollKeys.ts");
  const c = await mountChat();
  await pause(c);
  await c.h.act(() => {
    c.el.scrollTop = SCROLL_H - CLIENT_H - 20; // a page down from here overshoots the bottom
    scrollChatByKey(c.el, "PageDown", c.h.current.anchorToBottom, c.h.current.pause);
    c.h.current.onScroll();
  });
  assert.equal(c.h.current.anchored, true, "the eye calls this the bottom — live again");
  assert.equal(c.el.scrollTop, SCROLL_H, "re-anchor asserts the true bottom");
  await c.h.unmount();
});
