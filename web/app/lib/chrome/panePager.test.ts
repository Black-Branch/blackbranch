// The pager's transition table — every arrow named as its own test. Run:
//   node --test app/lib/chrome/panePager.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { progressOf, settleIndex, inMountWindow, MOUNT_WINDOW, createPagerMachine, SLIDE_MS, slideEase } from "./panePager.ts";

// A manual stand-in for the machine's `timers` seam: collects {fn, ms} instead
// of scheduling a real timer, so a test controls exactly when the quiet timer
// fires (`fire()`) — or never fires it at all, to prove a restart actually
// canceled the previous one rather than merely racing a real setTimeout.
function fakeTimers() {
  const pending: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const timers = {
    set: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.push({ id, fn, ms });
      return id;
    },
    clear: (t: unknown): void => {
      const i = pending.findIndex((p) => p.id === t);
      if (i !== -1) pending.splice(i, 1);
    },
  };
  const fire = (): void => {
    if (pending.length === 0) throw new Error("no timer pending");
    const t = pending.shift()!;
    t.fn();
  };
  const lastMs = (): number => {
    if (pending.length === 0) throw new Error("no timer pending");
    return pending[pending.length - 1]!.ms;
  };
  return { timers, fire, count: () => pending.length, lastMs };
}

function fakeCallbacks() {
  const hotCalls: boolean[] = [];
  const progressCalls: number[] = [];
  const settleCalls: number[] = [];
  return {
    hotCalls,
    progressCalls,
    settleCalls,
    onHot: (hot: boolean) => hotCalls.push(hot),
    onProgress: (p: number) => progressCalls.push(p),
    onSettle: (index: number) => settleCalls.push(index),
  };
}

test("progressOf clamps to [0, count-1]", () => {
  assert.equal(progressOf(150, 100, 3), 1.5, "in range");
  assert.equal(progressOf(500, 100, 3), 2, "clamped to count-1 above range");
  assert.equal(progressOf(-50, 100, 3), 0, "clamped to 0 below range");
});

test("progressOf returns 0 for paneWidth <= 0", () => {
  assert.equal(progressOf(100, 0, 3), 0, "zero paneWidth");
  assert.equal(progressOf(100, -10, 3), 0, "negative paneWidth");
});

test("settleIndex rounds and clamps", () => {
  assert.equal(settleIndex(1.4, 3), 1, "rounds down");
  assert.equal(settleIndex(1.6, 3), 2, "rounds up");
  assert.equal(settleIndex(-0.6, 3), 0, "clamped to 0 below range");
  assert.equal(settleIndex(5, 3), 2, "clamped to count-1 above range");
});

test("inMountWindow: inside, outside, and the boundary (strict <)", () => {
  assert.equal(inMountWindow(1, 0.3), true, "0.7 away — inside");
  assert.equal(inMountWindow(2, 0.3), false, "1.7 away — outside");
  assert.equal(inMountWindow(2, 0.75), false, "exactly MOUNT_WINDOW away — strict <, not <=");
  assert.equal(MOUNT_WINDOW, 1.25);
});

test("tick with a pending programmatic flag consumes it and does nothing else", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.programmatic();
  m.tick(0.5);
  assert.deepEqual(cb.hotCalls, [], "no onHot — the instant sync must not go hot");
  assert.deepEqual(cb.progressCalls, [], "no onProgress");
  assert.equal(count(), 0, "no timer started");
  assert.equal(m.state().hot, false);
});

test("programmatic() CANCELS a pending quiet timer — a stale settle would revert the write that caused the resync", () => {
  // The race this closes: an unmarked tick arms the quiet
  // timer on its own `lastProgress`; the resync then marks the next tick
  // programmatic, and that tick is SWALLOWED — so it never re-arms the timer,
  // but before this fix it never cleared the armed one either. ~120ms later
  // the stale timer fired and settled on the pre-resync position, committing a
  // pane the scroller had already left and reverting the fresh flag write that
  // drove the resync (in MatrixView: openRoom's collapse, or a back arrow).
  const { timers, fire, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });

  m.tick(0.4);
  assert.equal(count(), 1, "setup: a real tick armed the quiet timer");
  assert.deepEqual(cb.hotCalls, [true], "setup: and went hot");

  m.programmatic();
  assert.equal(count(), 0, "the pending quiet timer must be gone — nothing may settle off the pre-resync position");
  // EXACTLY-ONCE PAIRING, and it is the MACHINE that owes it. Cancelling
  // the timer means no settle will arrive, and a settle was the only thing
  // that dropped `hot` and emitted onHot(false). Leaving `hot` true here (or
  // letting the HOST emit the false while the machine still believed itself
  // hot) desyncs the two, and the NEXT swipe pays: see the follow-up gesture
  // below, which is the reproduction.
  assert.deepEqual(cb.hotCalls, [true, false], "the cancelled gesture must be closed out here, exactly once");
  assert.equal(m.state().hot, false, "…and the machine must AGREE it is no longer hot");
  assert.deepEqual(cb.settleCalls, [], "a cancelled gesture must never commit — that is the whole point");

  // The swallowed tick (the resync's own scrollTo) must not re-arm the timer,
  // or the clear above buys one tick of nothing — and must not read as a new
  // gesture either.
  m.tick(0.5);
  assert.equal(count(), 0, "the swallowed tick re-armed the timer — the clear is undone");
  assert.deepEqual(cb.hotCalls, [true, false], "the swallowed tick is not a new gesture");
  assert.throws(() => fire(), /no timer pending/, "there is genuinely nothing left to fire");

  // THE REPRODUCTION: the next genuine swipe must open normally. With `hot`
  // left true above, `tick` would see itself already hot and emit NO
  // onHot(true) — and this gesture's settle would then emit a second, unpaired
  // onHot(false): [true, false, false], and the reveal bar never opens
  // for the follow-up swipe.
  m.tick(0.6);
  assert.deepEqual(cb.hotCalls, [true, false, true], "the follow-up gesture never opened — the machine still believed it was hot");
  assert.deepEqual(cb.progressCalls, [0.4, 0.6], "…and its progress must flow again");
  assert.equal(count(), 1, "a real gesture arms the quiet timer again");

  m.end(0.6);
  assert.deepEqual(cb.hotCalls, [true, false, true, false], "the follow-up gesture's settle pairs its own open");
  assert.deepEqual(cb.settleCalls, [1], "…and commits, unlike the cancelled one");
});

test("first tick goes hot; every tick forwards progress and restarts the quiet timer", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.tick(0.1);
  assert.deepEqual(cb.hotCalls, [true], "first tick sets hot");
  assert.deepEqual(cb.progressCalls, [0.1]);
  assert.equal(count(), 1, "quiet timer armed");
  const firstTimerCount = count();
  m.tick(0.2);
  assert.deepEqual(cb.hotCalls, [true], "already hot — onHot not called again");
  assert.deepEqual(cb.progressCalls, [0.1, 0.2], "every tick forwards progress");
  assert.equal(count(), firstTimerCount, "old timer canceled, fresh one armed — never more than one pending");
  assert.equal(m.state().hot, true);
});

test("quietMs defaults to 120ms; an explicit quietMs is honoured", () => {
  const { timers, lastMs } = fakeTimers();
  const cb = fakeCallbacks();
  const mDefault = createPagerMachine({ count: () => 3, ...cb, timers });
  mDefault.tick(0.1);
  assert.equal(lastMs(), 120, "no quietMs given — the 120ms default is what got scheduled");

  const { timers: timers2, lastMs: lastMs2 } = fakeTimers();
  const cb2 = fakeCallbacks();
  const mExplicit = createPagerMachine({ count: () => 3, ...cb2, timers: timers2, quietMs: 500 });
  mExplicit.tick(0.1);
  assert.equal(lastMs2(), 500, "explicit quietMs overrides the default");
});

test("end while hot settles: onHot(false), timer cleared, onSettle(settleIndex(p, count()))", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.tick(0.5);
  m.end(1.6);
  assert.deepEqual(cb.hotCalls, [true, false]);
  assert.deepEqual(cb.settleCalls, [2], "settleIndex(1.6, 3) === 2");
  assert.equal(count(), 0, "quiet timer cleared on settle");
  assert.equal(m.state().hot, false);
});

test("end while not hot is ignored — the instant sync's own scrollend", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.programmatic();
  m.tick(1); // consumed — stays not-hot
  m.end(1); // the programmatic sync's own trailing scrollend
  assert.deepEqual(cb.hotCalls, [], "never went hot, end() is a no-op");
  assert.deepEqual(cb.settleCalls, [], "no settle");
  assert.equal(count(), 0);
});

test("the quiet timer settles identically when scrollend never fires", () => {
  const { timers, fire, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.tick(0.9);
  fire(); // scrollend never arrived — the quiet timer is the fallback
  assert.deepEqual(cb.hotCalls, [true, false]);
  assert.deepEqual(cb.settleCalls, [1], "settleIndex(0.9, 3) === 1, from the last ticked progress");
  assert.equal(count(), 0);
  assert.equal(m.state().hot, false);
});

test("count() is read at settle time, not captured at tick time", () => {
  // Ticks land at progress 2.4 while count() answers 4; count() then shrinks
  // to 2 (a pane closed mid-gesture) before the settle actually fires. If the
  // machine had captured count() on tick, this would settle against the
  // stale 4-wide range; it must instead re-read count() at the moment it
  // settles, clamping into the NEW 2-wide range.
  let liveCount = 4;
  const { timers, fire } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => liveCount, ...cb, timers });
  m.tick(2.4);
  liveCount = 2;
  fire();
  assert.deepEqual(cb.settleCalls, [1], "settleIndex(2.4, 2) === 1 — clamped against the count AT settle time");
});

test("after a settle, the next tick starts a fresh hot cycle", () => {
  const { timers } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.tick(0.5);
  m.end(0.5);
  assert.deepEqual(cb.hotCalls, [true, false]);
  m.tick(1.5);
  assert.deepEqual(cb.hotCalls, [true, false, true], "a fresh cycle goes hot again");
  assert.equal(m.state().hot, true);
});

test("programmatic flag consumed by exactly one tick — the second tick of a real gesture goes hot", () => {
  const { timers } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.programmatic();
  m.tick(0.5); // consumed, no-op
  assert.deepEqual(cb.hotCalls, []);
  m.tick(0.6); // a real gesture tick right behind it
  assert.deepEqual(cb.hotCalls, [true], "the second tick is a real one — goes hot");
  assert.deepEqual(cb.progressCalls, [0.6]);
});

test("dispose clears the timer and makes all further events no-ops", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 3, ...cb, timers });
  m.tick(0.5);
  assert.equal(count(), 1);
  m.dispose();
  assert.equal(count(), 0, "pending quiet timer cleared");
  const hotBefore = cb.hotCalls.length;
  const progressBefore = cb.progressCalls.length;
  const settleBefore = cb.settleCalls.length;
  m.tick(0.9);
  m.end(0.9);
  m.programmatic();
  m.dispose(); // idempotent
  assert.equal(cb.hotCalls.length, hotBefore, "tick after dispose is a no-op");
  assert.equal(cb.progressCalls.length, progressBefore);
  assert.equal(cb.settleCalls.length, settleBefore, "end after dispose is a no-op");
  assert.equal(count(), 0, "still no timer — dispose stays inert");
});

test("slideEase: clamped, monotonic ease-out over [0,1]; SLIDE_MS is the 200ms house duration", () => {
  assert.equal(slideEase(0), 0, "starts at 0");
  assert.equal(slideEase(1), 1, "ends at 1");
  assert.equal(slideEase(-2), 0, "clamps below");
  assert.equal(slideEase(3), 1, "clamps above");
  let prev = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const v = slideEase(i / 20);
    assert.ok(v >= prev, `monotonic at t=${i / 20}`);
    prev = v;
  }
  assert.ok(slideEase(0.5) > 0.5, "ease-OUT: front-loaded — past halfway by half time");
  // The duration is a contract term: UA smooth is ~2× this and untunable.
  assert.equal(SLIDE_MS, 200);
});

// ── The click slide's settle. In Chrome and Firefox alike, a per-frame
// `scrollLeft` tween is N instant scrolls, and EACH one fires its own scroll +
// scrollend pair one frame later — so `end()` would arrive a dozen times per
// tap and commit a different pane every frame (the mid-flight re-renders are
// jitter, and a slow device's resync snaps it back to the wrong pane). The
// tween owns its settle: while `sliding`, ticks still drive hot + progress (the
// band follows), but `end()` and the quiet timer are ignored; the LANDING
// settles exactly once.

test("while sliding, ticks drive progress but end() and the quiet timer NEVER commit", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(2.8);
  assert.deepEqual(cb.hotCalls, [true], "the slide goes hot like a gesture — the band must follow it");
  assert.deepEqual(cb.progressCalls, [2.8]);
  assert.equal(count(), 0, "no quiet timer while sliding — a slow frame would settle mid-flight");
  m.end(2.8);            // the per-frame scrollend
  m.tick(1.9);
  m.end(1.9);
  m.tick(1.1);
  m.end(1.1);
  assert.deepEqual(cb.settleCalls, [], "a dozen scrollends per tap, and not one of them may commit");
  assert.deepEqual(cb.hotCalls, [true], "still hot, still one gesture");
  assert.deepEqual(cb.progressCalls, [2.8, 1.9, 1.1], "every tick still reaches the band");
  assert.equal(count(), 0, "still no timer");
});

test("slideLand settles exactly once at the target and closes the hot pairing", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(2.5);
  m.tick(0.4);
  m.slideLand(0, false);
  assert.deepEqual(cb.settleCalls, [0], "one commit, at the target");
  assert.deepEqual(cb.hotCalls, [true, false], "the slide's open is paired by its landing");
  assert.equal(m.state().hot, false);
  assert.equal(count(), 0);
  // Nothing sliding any more — a real gesture is a fresh cycle.
  m.tick(0.3);
  assert.deepEqual(cb.hotCalls, [true, false, true], "the next tick is a new gesture");
  assert.equal(count(), 1, "…and arms the quiet timer again");
});

test("slideLand(moved=true) swallows exactly the trailing tick — the final write's scroll event arrives one frame AFTER landing", () => {
  const { timers, count, fire } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(1.2);
  m.slideLand(0, true);
  assert.deepEqual(cb.settleCalls, [0]);
  // The trailing tick (measured: raf:188 writes, scroll:205 fires). Without
  // the swallow it re-hots the machine and the quiet timer commits AGAIN.
  m.tick(0);
  assert.deepEqual(cb.hotCalls, [true, false], "the trailing tick is not a new gesture");
  assert.deepEqual(cb.progressCalls, [1.2], "…and does not reach the band");
  assert.equal(count(), 0, "…and arms nothing");
  assert.throws(() => fire(), /no timer pending/);
  assert.deepEqual(cb.settleCalls, [0], "exactly one commit per tap");
  // And exactly ONE tick is swallowed — the user's next swipe opens normally.
  m.tick(0.2);
  assert.deepEqual(cb.hotCalls, [true, false, true]);
  assert.equal(count(), 1);
});

test("slideLand(moved=false) swallows nothing — no scroll event is coming, so the next tick is the user's", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(0.1);
  m.slideLand(0, false);
  m.tick(0.3);
  assert.deepEqual(cb.hotCalls, [true, false, true], "a write that did not move fires no event — the swallow would eat a real gesture's first tick");
  assert.equal(count(), 1);
});

test("slideAbort clears sliding without a commit — the user's grab then finishes under native physics", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(2.4);
  m.slideAbort();
  assert.deepEqual(cb.settleCalls, [], "an aborted slide never commits");
  assert.deepEqual(cb.hotCalls, [true], "the gesture is STILL in flight — the user has the scroller");
  assert.equal(m.state().hot, true);
  m.tick(2.2);
  assert.equal(count(), 1, "the user's ticks arm the quiet timer again");
  m.end(2.2);
  assert.deepEqual(cb.settleCalls, [2], "…and their release settles normally");
  assert.deepEqual(cb.hotCalls, [true, false]);
});

test("programmatic() clears sliding too — a resync already cancelled the tween", () => {
  const { timers, count } = fakeTimers();
  const cb = fakeCallbacks();
  const m = createPagerMachine({ count: () => 4, ...cb, timers });
  m.slideBegin();
  m.tick(1.5);
  m.programmatic();
  assert.deepEqual(cb.hotCalls, [true, false], "closed out by the resync, as any gesture is");
  m.tick(3);             // the resync's own scrollTo — swallowed
  m.tick(2.9);           // a real gesture
  assert.deepEqual(cb.hotCalls, [true, false, true]);
  assert.equal(count(), 1, "the quiet timer is live again — sliding did not survive the resync");
  m.end(2.9);
  assert.deepEqual(cb.settleCalls, [3], "a real scrollend commits again");
});
