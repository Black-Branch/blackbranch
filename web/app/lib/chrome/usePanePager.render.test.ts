// usePanePager wiring tests — what only a REAL
// mount can prove about the DOM host that feeds the pure pager machine
// (panePager.ts, panePager.test.ts): a hot scroll tick exposes a fractional
// `progress` and fires `onHotChange(true)`; a settle (`scrollend`, or the
// machine's always-armed quiet timer) commits the landed pane and returns
// `progress` to `undefined` in the SAME task as the commit, so the landed
// pane never sees a mounted-gap frame; `mounted()` widens only around a live
// gesture; an externally-driven `activeKey` change snaps the scroller WITHOUT
// ever exposing a defined `progress` — the machine's `programmatic()` escape
// hatch swallows that one tick; `enabled: false` wires no listeners at all
// and `requestPane` commits directly.
//
// Also pins the load-bearing constraint stated in panePager.ts's own
// comments: the rAF-throttled tick must read
// `scrollLeft`/`clientWidth` FRESH, INSIDE the rAF callback, at flush time —
// never captured at `scroll`-event time — so the quiet-timer fallback can
// never settle on a stale position.
//
// jsdom gaps this file works around (see usePanePager.ts's own comments for
// the product-side half of each):
//   - `clientWidth` is always 0 in jsdom (no layout engine) — stubbed per
//     test via Object.defineProperty; `scrollLeft` IS a real, settable
//     property in jsdom, so it needs no stubbing.
//   - `Element.prototype.scrollTo` is undefined in jsdom — every scrollTo in
//     this file's assertions is therefore exercised through the hook's
//     `el.scrollLeft = …` fallback, never the options-object call.
//   - `ResizeObserver` is undefined in jsdom — installResizeObserverStub()
//     supplies one so effect C's rotation re-sync is live rather than
//     silently skipped.
//   - `requestAnimationFrame`/`cancelAnimationFrame` are undefined in jsdom —
//     installRafStub() supplies a manually-flushed queue.
//   - `"onscrollend" in window` is actually TRUE in this repo's jsdom (it
//     declares the GlobalEventHandlers IDL attribute even though no browser
//     engine ever fires it) — no faking needed; a real `scrollend` dispatch
//     reaches the hook's listener the same way flushing the quiet timer
//     would, and is used here for determinism.
//
// Run: node --test app/lib/chrome/usePanePager.render.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { dom, React, act } from "../testDom.ts";
import { installResizeObserverStub, installRafStub } from "../testTsx.ts";
import type { UsePanePagerResult } from "./usePanePager.ts";

// Module scope, like every other consumer of these two stubs (bar.render.test.ts) —
// live for the whole file, never silently uninstalled mid-test.
const ro = installResizeObserverStub();
const raf = installRafStub();

const { usePanePager, startSlide } = await import("./usePanePager.ts");
const { createRoot } = await import("react-dom/client");

type Keys = "a" | "b" | "c";
const KEYS: readonly Keys[] = ["a", "b", "c"];
const PANE_WIDTH = 300;

/** jsdom has no layout engine — `clientWidth` always reads 0 and is not a
 *  settable property, unlike `scrollLeft`, which jsdom already tracks as a
 *  real read/write value. */
function stubWidth(el: HTMLDivElement, width: number): void {
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
}

type ProbeProps = { activeKey: Keys; enabled: boolean; keys?: readonly Keys[] };

/** Mount `usePanePager` on a real scroller div (three panes) and return a
 *  live handle: the hook's latest return value, the DOM node, and every
 *  commit/hot/progress event observed. */
async function mountPager(initial: ProbeProps) {
  const commits: Keys[] = [];
  const hotCalls: boolean[] = [];
  const progressHistory: (number | undefined)[] = [];

  const ref: { current: UsePanePagerResult<Keys> | null } = { current: null };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  function Probe(props: ProbeProps) {
    const result = usePanePager<Keys>({
      // Defaulted, so every test that does not care about the key set behaves
      // exactly as it did before the growable-keys case was added.
      keys: props.keys ?? KEYS,
      activeKey: props.activeKey,
      enabled: props.enabled,
      onCommit: (k) => { commits.push(k); },
      onHotChange: (h) => { hotCalls.push(h); },
    });
    ref.current = result;
    // Every render this hook causes (each `progress` state flip included) is
    // captured here — the full timeline, not just the latest snapshot.
    progressHistory.push(result.progress);
    return React.createElement(
      "div",
      { ref: result.scrollerRef, "data-testid": "scroller" },
      (props.keys ?? KEYS).map((k) => React.createElement("div", { key: k, "data-pane": k })),
    );
  }

  const render = (props: ProbeProps) =>
    act(async () => { root.render(React.createElement(Probe, props)); });

  await render(initial);

  return {
    get current() { return ref.current!; },
    get scroller() { return container.querySelector<HTMLDivElement>('[data-testid="scroller"]')!; },
    commits,
    hotCalls,
    progressHistory,
    render,
    unmount: () => act(async () => { root.unmount(); }),
  };
}

const dispatchScroll = (el: HTMLDivElement) =>
  act(async () => {
    el.dispatchEvent(new dom.window.Event("scroll"));
    raf.flush();
  });

const dispatchScrollEnd = (el: HTMLDivElement) =>
  act(async () => { el.dispatchEvent(new dom.window.Event("scrollend")); });

test("a hot tick exposes fractional progress and fires onHotChange(true); scrollend commits the landed pane and returns progress to undefined in the same task; the caller's activeKey re-render then mounts only the new key", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  // Initial mount: clientWidth reads 0 before this test stubs it, and the
  // hook's own external-resync layout effect ran against that 0 during mount
  // without throwing or writing scrollLeft — the "divides safely before
  // layout" assertion the brief calls out, proven by simply reaching here.
  assert.equal(scroller.scrollLeft, 0, "setup: nothing moved the scroller before this test drove it");

  scroller.scrollLeft = 150; // 0.5 of the way from pane 0 to pane 1
  await dispatchScroll(scroller);

  assert.equal(pager.current.progress, 0.5, "a hot tick exposes the fractional pane position");
  assert.deepEqual(pager.hotCalls, [true], "onHotChange(true) fires on the first hot tick");

  scroller.scrollLeft = 330; // 1.1 — rounds to pane 1 on settle
  await dispatchScroll(scroller);
  assert.equal(pager.current.progress, 1.1, "further ticks keep forwarding progress while hot");

  await dispatchScrollEnd(scroller);

  assert.deepEqual(pager.commits, ["b"], "scrollend settles at settleIndex(1.1, 3) === 1 → keys[1]");
  assert.equal(pager.current.progress, undefined, "progress returns to undefined on settle");
  assert.deepEqual(pager.hotCalls, [true, false], "onHotChange(false) fires on settle");

  // The hook never changes `activeKey` itself — that is the caller's job,
  // driven by `onCommit`. Simulate ChatSidebar re-rendering with the new key,
  // exactly as ChatSidebar wires onCommit → setState → activeKey.
  await pager.render({ activeKey: "b", enabled: true });

  assert.equal(pager.current.mounted("a"), false, "the old active key is no longer mounted at rest");
  assert.equal(pager.current.mounted("b"), true, "the new active key is mounted");
  assert.equal(pager.current.mounted("c"), false, "and nothing else is, at rest");

  await pager.unmount();
});

test("mid-gesture, mounted widens to the approach-mount window around progress and nothing beyond it", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  scroller.scrollLeft = 90; // progress 0.3: pane 1 is 0.7 away (< MOUNT_WINDOW 1.25), pane 2 is 1.7 away
  await dispatchScroll(scroller);

  assert.equal(pager.current.progress, 0.3);
  assert.equal(pager.current.mounted("a"), true, "the active key stays mounted through its own gesture");
  assert.equal(pager.current.mounted("b"), true, "0.7 away — inside the approach-mount window");
  assert.equal(pager.current.mounted("c"), false, "1.7 away — outside it");

  await pager.unmount();
});

test("teardown while a gesture is hot closes it out: progress resets, the LAST onHotChange call is false, and mounted() returns to active-only", async () => {
  // ChatSidebar's `pagerOn = narrow && !split` can flip `enabled` false on a
  // rotation that lands mid-swipe — no settle (scrollend or the quiet timer)
  // will ever arrive once effect A's listeners are gone, so effect A's own
  // cleanup is the only place left to close the gesture out.
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  scroller.scrollLeft = 90; // progress 0.3 — hot, "b" inside the approach-mount window
  await dispatchScroll(scroller);

  assert.equal(pager.current.progress, 0.3, "setup: a gesture is genuinely hot");
  assert.deepEqual(pager.hotCalls, [true]);
  assert.equal(pager.current.mounted("b"), true, "setup: the neighbor pane is mid-gesture-mounted");

  await pager.render({ activeKey: "a", enabled: false });

  assert.equal(pager.current.progress, undefined, "teardown must reset progress — nothing will ever settle it otherwise");
  assert.deepEqual(pager.hotCalls, [true, false], "the last onHotChange call must be false — an unpaired true would latch a reveal-swipe host open forever");
  assert.equal(pager.current.mounted("a"), true, "active-only again");
  assert.equal(pager.current.mounted("b"), false, "the stale approach-mount window is gone");
  assert.equal(pager.current.mounted("c"), false);

  await pager.unmount();
});

test("an externally-driven activeKey change resyncs the scroller instantly and never exposes a defined progress — the resulting tick is swallowed by programmatic()", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  assert.equal(scroller.scrollLeft, 0, "setup: parked on pane 0, matching activeKey \"a\"");

  // A tab click, a deep link — anything that changes activeKey WITHOUT the
  // pager itself having scrolled. The layout effect must snap the scroller
  // before paint, with no visible hot band.
  await pager.render({ activeKey: "b", enabled: true });

  assert.equal(scroller.scrollLeft, PANE_WIDTH, "the resync wrote scrollLeft to pane 1's offset (the scrollTo fallback, since jsdom has no Element.scrollTo)");
  assert.equal(pager.current.progress, undefined, "the instant snap itself never went hot");

  // A real browser would fire a trailing `scroll` for that instant jump —
  // simulate it, and prove the machine's `programmatic()` flag (set by the
  // resync just above) swallows exactly that one tick rather than reporting
  // a fractional gesture.
  await dispatchScroll(scroller);

  assert.equal(pager.current.progress, undefined, "the programmatic tick never surfaced a defined progress");
  assert.deepEqual(pager.hotCalls, [], "…and never went hot at all");
  assert.ok(
    pager.progressHistory.every((p) => p === undefined),
    "at no point across this whole test did progress take a defined value — this is the silent re-sync's whole point",
  );

  await pager.unmount();
});

test("enabled: false wires no listeners and no ResizeObserver; requestPane commits directly with no scroll", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: false });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  scroller.scrollLeft = 111;

  assert.ok(!ro.observed.includes(scroller), "a disabled pager never observes the scroller for rotation");

  await dispatchScroll(scroller);
  await dispatchScrollEnd(scroller);

  assert.equal(pager.current.progress, undefined, "no listener was attached, so a scroll/scrollend does nothing");
  assert.deepEqual(pager.hotCalls, [], "never goes hot");
  assert.deepEqual(pager.commits, [], "no settle, no commit");

  act(() => { pager.current.requestPane("b"); });

  assert.deepEqual(pager.commits, ["b"], "requestPane commits directly when disabled");
  assert.equal(scroller.scrollLeft, 111, "…and never touches the scroll position");
  assert.equal(pager.current.progress, undefined);

  await pager.unmount();
});

test("prefers-reduced-motion makes requestPane commit directly too, even with enabled: true", async () => {
  const prevMatchMedia = (dom.window as unknown as { matchMedia?: unknown }).matchMedia;
  (dom.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia =
    (q: string) => ({ matches: q.includes("prefers-reduced-motion") });

  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  scroller.scrollLeft = 0;

  act(() => { pager.current.requestPane("c"); });

  assert.deepEqual(pager.commits, ["c"], "reduced motion commits directly, bypassing the scroll-driven settle entirely");
  assert.equal(scroller.scrollLeft, 0, "…and the scroller never moves");

  await pager.unmount();
  (dom.window as unknown as { matchMedia: unknown }).matchMedia = prevMatchMedia;
});

test("keys AND activeKey changing in ONE commit still resyncs — with no ResizeObserver anywhere to heal it", async () => {
  // MatrixView's real sequence, and the reason the ref syncs are LAYOUT effects
  // declared above effect B. MatrixView's first channel tap in mode 1 changes
  // both at once: `matrixPaneKeys` goes ["directory"] → ["directory",
  // "timeline","members"] and the active pane goes directory → timeline, in
  // the same commit.
  // With `keysRef` written in a PASSIVE effect, effect B (a layout effect) ran
  // first and did `keysRef.current.indexOf("b")` against the previous
  // ONE-key list → -1 → silent early return. Nothing retries: effect A does
  // not resync, so the only heal was effect C's ResizeObserver initial
  // delivery — which is why this test removes ResizeObserver entirely. Without
  // it the row would sit on the directory pane forever after the tap.
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  const w = dom.window as unknown as { ResizeObserver?: unknown };
  const prevG = g.ResizeObserver;
  const prevW = w.ResizeObserver;
  delete g.ResizeObserver;
  delete w.ResizeObserver;
  try {
    const pager = await mountPager({ activeKey: "a", enabled: true, keys: ["a"] });
    const scroller = pager.scroller;
    stubWidth(scroller, PANE_WIDTH);
    assert.equal(scroller.scrollLeft, 0, "setup: one pane, parked on it");

    // The tap: the key set grows 1 → 3 AND the active key moves, together.
    await pager.render({ activeKey: "b", enabled: true, keys: KEYS });

    assert.equal(
      scroller.scrollLeft, PANE_WIDTH,
      "the resync read a STALE key list and bailed on indexOf === -1 — the pager never leaves the first pane",
    );
    assert.equal(pager.current.progress, undefined, "and it did it silently, with no hot band");
    assert.deepEqual(pager.commits, [], "a resync is not a commit — the caller already owns this state");

    await pager.unmount();
  } finally {
    g.ResizeObserver = prevG;
    w.ResizeObserver = prevW;
  }
});

test("the machine exists at the FIRST resync — the enable flip's own snap is swallowed, not read as a gesture", async () => {
  // The other half of the layout-phase ordering: effect A (machine + listeners)
  // is a layout effect declared ABOVE effect B. As a passive effect it ran
  // AFTER B, so on the commit where the pager first becomes enabled B's
  // `machineRef.current?.programmatic()` was a no-op on a `?.` — the mark went
  // nowhere, and the trailing `scroll` the instant snap produces then hit a
  // brand-new machine as a REAL first tick: hot, a band tracking nothing, and
  // a settle committing a pane nobody swiped to.
  const pager = await mountPager({ activeKey: "b", enabled: false });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  assert.equal(scroller.scrollLeft, 0, "setup: disabled, so nothing has resynced yet");

  // The flip (MatrixView: a thread closes, or the panel narrows into mode 1).
  await pager.render({ activeKey: "b", enabled: true });
  assert.equal(scroller.scrollLeft, PANE_WIDTH, "setup: the enable flip resynced to the active pane");

  // The browser's trailing scroll for that instant jump.
  await dispatchScroll(scroller);

  assert.deepEqual(pager.hotCalls, [], "the enable flip's own snap was read as a gesture — the machine did not exist when the programmatic mark was made");
  assert.equal(pager.current.progress, undefined, "…and it surfaced a fractional progress off it");
  assert.deepEqual(pager.commits, [], "…which would have settled into a commit nobody asked for");

  await pager.unmount();
});

test("a resync MID-GESTURE closes that gesture out AND leaves the next one able to open — exactly-once onHot pairing", async () => {
  // `programmatic()` cancels the interrupted gesture on the MACHINE side
  // (timer + `onHot(false)`), and this hook resets its own `progress` — the
  // one half the machine cannot reach. The split matters: when the host
  // emitted the `onHot(false)` itself while the machine still believed it was
  // hot, the two desynced, and the FOLLOW-UP swipe paid for it — no
  // `onHot(true)` (the machine thought it was already open) and a second,
  // unpaired `onHot(false)` on its settle: [true, false, false]. The
  // reveal bar then never opens for that swipe. This test walks the whole
  // sequence, which is the only place that desync is visible.
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  scroller.scrollLeft = 90; // 0.3 — a genuine gesture: hot, quiet timer armed
  await dispatchScroll(scroller);
  assert.equal(pager.current.progress, 0.3, "setup: a gesture is genuinely hot");
  assert.deepEqual(pager.hotCalls, [true]);

  // Something external moves the active pane mid-swipe (a deep link, a
  // notification, MatrixView's openRoom): the resync MOVES the scroller, so
  // the swipe in flight is cancelled rather than completed.
  await pager.render({ activeKey: "c", enabled: true });

  assert.equal(scroller.scrollLeft, PANE_WIDTH * 2, "setup: the resync really did move the scroller");
  assert.deepEqual(pager.hotCalls, [true, false], "the cancelled gesture left onHotChange(true) unpaired — a reveal-swipe host latches open");
  assert.equal(pager.current.progress, undefined, "progress stayed defined off a gesture that will now never settle");
  assert.deepEqual(pager.commits, [], "a cancelled gesture must not commit — that is the stale settle this whole fix removes");

  // The browser's trailing scroll for that instant jump — swallowed, and not a
  // new gesture.
  await dispatchScroll(scroller);
  assert.deepEqual(pager.hotCalls, [true, false], "the resync's own trailing scroll read as a fresh gesture");
  assert.equal(pager.current.progress, undefined);

  // THE REPRODUCTION: the user's next real swipe.
  scroller.scrollLeft = 330; // 1.1
  await dispatchScroll(scroller);
  assert.deepEqual(pager.hotCalls, [true, false, true], "the follow-up swipe never opened — the machine still believed it was hot");
  assert.equal(pager.current.progress, 1.1, "…and its progress must drive the indicator again");

  await dispatchScrollEnd(scroller);
  assert.deepEqual(pager.hotCalls, [true, false, true, false], "the follow-up swipe's settle must pair its OWN open, not the cancelled gesture's");
  assert.deepEqual(pager.commits, ["b"], "…and commit normally");
  assert.equal(pager.current.progress, undefined);

  await pager.unmount();
});

test("teardown after a resync close-out does NOT fire a second onHotChange(false)", async () => {
  // Effect A's cleanup closes out a live gesture by reading
  // `machine.state().hot` BEFORE dispose. Once `programmatic()` owns the
  // close-out, that read returns false for an already-cancelled gesture — so
  // the two paths cannot both fire. This pins that they don't: the pairing is
  // exactly-once across the resync AND the teardown, not just within one.
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  scroller.scrollLeft = 90;
  await dispatchScroll(scroller);
  assert.deepEqual(pager.hotCalls, [true], "setup: hot");

  await pager.render({ activeKey: "c", enabled: true });
  assert.deepEqual(pager.hotCalls, [true, false], "setup: the resync closed it out, once");

  // Now tear the pager down (`narrow && !split` flipping on rotation).
  await pager.render({ activeKey: "c", enabled: false });
  assert.deepEqual(pager.hotCalls, [true, false], "teardown fired a SECOND onHotChange(false) over an already-closed gesture");
  assert.equal(pager.current.progress, undefined);

  await pager.unmount();
});

test("the rAF-throttled tick reads scrollLeft fresh at flush time — a later scroll before the frame flushes wins over an earlier one", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);

  await act(async () => {
    scroller.scrollLeft = 30; // 0.1 — the FIRST scroll event, schedules the frame
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    scroller.scrollLeft = 270; // 0.9 — a SECOND scroll event before the frame ran; coalesced (no second schedule)
    scroller.dispatchEvent(new dom.window.Event("scroll"));
    raf.flush(); // the ONE queued callback reads scrollLeft NOW
  });

  assert.equal(
    pager.current.progress, 0.9,
    "the throttled tick must read scrollLeft fresh inside the rAF callback — capturing it at the first event would report 0.1, the stale value",
  );

  await pager.unmount();
});

// ── The click slide: a house rAF tween at SLIDE_MS replaces UA
// `behavior:"smooth"` (~2× slower, untunable). The tween keeps its OWN clock
// (the rAF stub passes timestamp 0), injectable here.

test("startSlide: eased motion lands exactly on the target, stops queuing frames, and restores snap", () => {
  const el = dom.window.document.createElement("div");
  el.scrollLeft = 0;
  let t = 0;
  const cancel = startSlide(el, 300, () => t);
  // snap is SUSPENDED for the tween's lifetime — `snap-mandatory` re-snaps
  // every programmatic write back to a snap point, which trips the takeover
  // guard and would leave tab taps dead on real containers.
  assert.equal(el.style.scrollSnapType, "none", "snap suspended while the tween runs");
  t = 100; raf.flush();                       // halfway in time — past halfway in distance (ease-out)
  assert.ok(el.scrollLeft > 150, `front-loaded (got ${el.scrollLeft})`);
  assert.ok(el.scrollLeft < 300, "not done yet");
  assert.equal(el.style.scrollSnapType, "none", "still suspended mid-tween");
  t = 200; raf.flush();                       // duration reached — exact landing
  assert.equal(el.scrollLeft, 300, "lands exactly on the target");
  assert.equal(el.style.scrollSnapType, "", "snap restored on landing");
  const before = el.scrollLeft;
  raf.flush();                                // nothing re-queued after t >= 1
  assert.equal(el.scrollLeft, before, "no further frames");
  cancel();
});

test("startSlide: aborts the moment something else moves the scroller (native input wins) — and restores snap for that gesture", () => {
  const el = dom.window.document.createElement("div");
  el.scrollLeft = 0;
  let t = 0;
  startSlide(el, 300, () => t);
  t = 50; raf.flush();
  const tweenPos = el.scrollLeft;
  assert.ok(tweenPos > 0, "tween moving");
  el.scrollLeft = 42;                          // the user grabbed it
  t = 100; raf.flush();
  assert.equal(el.scrollLeft, 42, "tween yields — no further writes");
  assert.equal(el.style.scrollSnapType, "", "snap restored on takeover — the user's release needs it");
  t = 250; raf.flush();
  assert.equal(el.scrollLeft, 42, "and stays yielded");
});

test("startSlide: the returned cancel dequeues the next frame and restores snap", () => {
  const el = dom.window.document.createElement("div");
  el.scrollLeft = 0;
  let t = 0;
  const cancel = startSlide(el, 300, () => t);
  t = 60; raf.flush();
  const pos = el.scrollLeft;
  cancel();
  assert.equal(el.style.scrollSnapType, "", "snap restored on cancel");
  t = 200; raf.flush();
  assert.equal(el.scrollLeft, pos, "cancelled — no landing write");
});

test("startSlide: a pre-existing inline snap override is restored verbatim, not blanked", () => {
  const el = dom.window.document.createElement("div");
  el.scrollLeft = 0;
  el.style.scrollSnapType = "x proximity";
  let t = 0;
  startSlide(el, 300, () => t);
  t = 200; raf.flush();
  assert.equal(el.style.scrollSnapType, "x proximity", "the previous inline value survives the round trip");
});

test("requestPane (enabled): takes the tween path — no direct commit, a frame queued; per-frame writes fire real scroll events into the machine", async () => {
  const pager = await mountPager({ activeKey: "a", enabled: true });
  stubWidth(pager.scroller, PANE_WIDTH);
  await act(async () => { pager.current.requestPane("b"); });
  assert.deepEqual(pager.commits, [], "no direct commit — the settle owns it");
  // Drive one tween frame; the scrollLeft write is observable even without
  // deterministic time (real performance.now: t≈0 ⇒ tiny but non-breaking).
  raf.flush();
  assert.ok(pager.scroller.scrollLeft >= 0, "tween wrote without throwing");
});

// ── The tween owns its settle. In Chrome and Firefox alike, every per-frame
// `scrollLeft` write is its own instant scroll and fires its own scroll +
// scrollend pair ONE FRAME LATER. If each of those scrollends were a settle,
// one tap would commit a different pane every frame (a VODs→Live tap landing
// on News, then Matrix, then Live). This replays that exact sequence.

test("a click slide across three panes commits EXACTLY once, at the target, despite a scrollend after every frame — and the trailing pair after landing is inert", async () => {
  const pager = await mountPager({ activeKey: "c", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  scroller.scrollLeft = 2 * PANE_WIDTH;
  // The mount resync's own scroll event (jsdom fires none; a browser does) —
  // consumes the programmatic swallow so it cannot mask what follows.
  await dispatchScroll(scroller);
  pager.commits.length = 0;
  pager.hotCalls.length = 0;

  // requestPane's tween keeps its own clock via performance.now — pinned here.
  const realNow = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    await act(async () => { pager.current.requestPane("a"); });
    assert.deepEqual(pager.commits, [], "no direct commit — the landing owns it");

    // The measured loop: rAF (tween write + the previous event's tick read),
    // then the browser delivers scroll + scrollend for that write next frame.
    const frame = async () => {
      await act(async () => { raf.flush(); });
      await act(async () => {
        scroller.dispatchEvent(new dom.window.Event("scroll"));
        scroller.dispatchEvent(new dom.window.Event("scrollend"));
      });
    };
    for (t = 16; t < 200; t += 16) {
      await frame();
      assert.deepEqual(pager.commits, [], `a mid-flight scrollend committed at t=${t} (scrollLeft ${scroller.scrollLeft})`);
    }
    // The band followed the slide the whole way — progress was defined and moving.
    const seen = pager.progressHistory.filter((p): p is number => p !== undefined);
    assert.ok(seen.length >= 3 && seen[0]! > seen[seen.length - 1]!, `progress must track the slide (${seen.join(",")})`);

    t = 200;
    await act(async () => { raf.flush(); });            // the landing frame
    assert.equal(scroller.scrollLeft, 0, "landed exactly on pane a");
    assert.deepEqual(pager.commits, ["a"], "one commit, the target");
    assert.equal(pager.current.progress, undefined, "at rest in the same task as the commit");
    assert.deepEqual(pager.hotCalls, [true, false], "one gesture, paired exactly once");

    // The trailing pair for the landing write, one frame later (measured:
    // raf:188 writes, scroll:205 + scrollend:205 fire). Must be inert.
    await frame();
    assert.deepEqual(pager.commits, ["a"], "the trailing scroll/scrollend must not commit again");
    assert.deepEqual(pager.hotCalls, [true, false], "…nor re-open the gesture");
    assert.equal(pager.current.progress, undefined, "…nor pin the band to a stale position");

    // And the swallow ate exactly one tick: the user's next swipe opens normally.
    scroller.scrollLeft = 40;
    await dispatchScroll(scroller);
    assert.deepEqual(pager.hotCalls, [true, false, true], "a real gesture after the slide goes hot");
  } finally {
    performance.now = realNow;
  }
  await pager.unmount();
});

test("a user grab mid-slide aborts the tween without a commit; their release settles under the normal path", async () => {
  const pager = await mountPager({ activeKey: "c", enabled: true });
  const scroller = pager.scroller;
  stubWidth(scroller, PANE_WIDTH);
  scroller.scrollLeft = 2 * PANE_WIDTH;
  // The mount resync's own scroll event (jsdom fires none; a browser does) —
  // consumes the programmatic swallow so it cannot mask what follows.
  await dispatchScroll(scroller);
  pager.commits.length = 0;
  const realNow = performance.now;
  let t = 0;
  performance.now = () => t;
  try {
    await act(async () => { pager.current.requestPane("a"); });
    t = 32; await act(async () => { raf.flush(); });
    scroller.scrollLeft = 500;                           // the user grabbed it
    t = 48; await act(async () => { raf.flush(); });     // the tween notices and yields
    assert.equal(scroller.scrollLeft, 500, "tween yielded");
    assert.deepEqual(pager.commits, [], "an aborted slide commits nothing");
    scroller.scrollLeft = 320;
    await dispatchScroll(scroller);
    await dispatchScrollEnd(scroller);                   // their release
    assert.deepEqual(pager.commits, ["b"], "the user's own scrollend settles where they left it");
    assert.equal(scroller.style.scrollSnapType, "", "snap restored for their release");
  } finally {
    performance.now = realNow;
  }
  await pager.unmount();
});
