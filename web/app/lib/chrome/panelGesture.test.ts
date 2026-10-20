// The panel gesture's arithmetic, pure and node-tested: ONE scalar — the
// panel's translate Y on a box held at cap height — where 0 is the cap (the
// panel's top on the ceiling), `fit` is contentFit, and below `fit` is a FREE
// position (a window can be repositioned without closing) until the box's
// visible height drops under MIN_VISIBLE_PX, where a release dismisses. Every
// number below is a plan-time value judged on device; the tests pin the SHAPE
// (where the free range starts and ends, which way a flick goes, what counts
// as a dismiss) against the constants, never by re-spelling them.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DRAG_SLOP_PX, MIN_VISIBLE_PX, FLICK_VY, VELOCITY_WINDOW_MS,
  dragOffset, nearestDetent, cancelTarget, releaseTarget, velocity,
} from "./panelGesture.ts";

const CAP = 500;   // the cap box's height — the pane minus the ceiling
const FIT = 120;   // contentFit: a 380px card in a 500px pane
const FLOOR = CAP - MIN_VISIBLE_PX; // the lowest scalar that still shows MIN_VISIBLE_PX of the box

test("constants are the tuned numbers — change them here and on device, nowhere else", () => {
  assert.equal(DRAG_SLOP_PX, 6);
  assert.equal(MIN_VISIBLE_PX, 72);
  assert.equal(FLICK_VY, 0.6);
  assert.equal(VELOCITY_WINDOW_MS, 80);
});

test("dragOffset: 1:1 everywhere — between the cap and contentFit, and BELOW contentFit too (a position, not a rubber band)", () => {
  assert.equal(dragOffset(FIT, -30, CAP), FIT - 30, "finger up from contentFit → toward the cap, 1:1");
  assert.equal(dragOffset(0, 50, CAP), 50, "finger down from the cap → toward contentFit, 1:1");
  assert.equal(dragOffset(FIT, -FIT, CAP), 0, "exactly at the cap");
  assert.equal(dragOffset(FIT, 100, CAP), FIT + 100,
    "below contentFit the box FOLLOWS the finger undamped — pull the appearance menu down to see the chat behind it, and it stays");
});

test("dragOffset: CLAMPS above the cap and below the composer — the box never leaves the composer, never goes further than fully behind it", () => {
  assert.equal(dragOffset(0, -100, CAP), 0, "above the cap the scalar CLAMPS — a negative scalar would lift the whole box off the composer (a 14px seam gap)");
  assert.equal(dragOffset(FIT, 1000, CAP), CAP, "fully behind the composer is as far as the scalar goes — the exit runs from wherever the finger lets go");
});

test("nearestDetent: the one nearest-detent rule ABOVE contentFit — the midpoint decides, and a task has only the cap", () => {
  assert.deepEqual(nearestDetent(40, 0), { kind: "detent", y: 0 }, "fit = 0 (a task): the cap is the only detent there is");
  assert.deepEqual(nearestDetent(59, FIT), { kind: "detent", y: 0 }, "above the midpoint → the cap");
  assert.deepEqual(nearestDetent(61, FIT), { kind: "detent", y: FIT }, "below it → contentFit");
});

test("cancelTarget: a cancel (the pager took the pan, or a keyboard commit under the finger) NEVER dismisses — a detent above contentFit, the position itself below it", () => {
  assert.deepEqual(cancelTarget(59, FIT, CAP), { kind: "detent", y: 0 }, "above contentFit: the nearest detent, as before");
  assert.deepEqual(cancelTarget(61, FIT, CAP), { kind: "detent", y: FIT });
  assert.deepEqual(cancelTarget(200, FIT, CAP), { kind: "free", y: 200 }, "below contentFit: the box stays exactly where the finger had it — a cancel is not a reason to move a repositioned window");
  assert.deepEqual(cancelTarget(FLOOR + 30, FIT, CAP), { kind: "free", y: FLOOR },
    "…but never under the minimum: a cancel with the box mostly behind the composer eases it up to the lowest position that still shows MIN_VISIBLE_PX");
  assert.deepEqual(cancelTarget(40, 0, CAP), { kind: "free", y: 40 }, "a task (fit = 0) can be repositioned too — everything below its cap is free");
});

test("cancelTarget: when the pane is too short for a free range (floor ≤ fit), below contentFit collapses to the contentFit detent", () => {
  // A keyboard-shrunk pane: cap 100, a 40px card → fit 60; the floor (100 − 72 = 28) sits ABOVE fit.
  assert.deepEqual(cancelTarget(70, 60, 100), { kind: "detent", y: 60 }, "no free range exists here — contentFit is the lowest resting place");
});

test("releaseTarget: dismiss by the MINIMUM — release with less than MIN_VISIBLE_PX of the box showing", () => {
  assert.deepEqual(releaseTarget(FLOOR + 1, 0, FIT, CAP), { kind: "dismiss" }, "one px under the minimum: the slide-down-to-close stays 'at a minimum height'");
  assert.deepEqual(releaseTarget(FLOOR - 1, 0, FIT, CAP), { kind: "free", y: FLOOR - 1 }, "one px above it: a position, kept");
  assert.deepEqual(releaseTarget(CAP, 0, FIT, CAP), { kind: "dismiss" }, "fully behind the composer");
});

test("releaseTarget: below contentFit a slow release LEAVES the box there — static repositioning, the L2.1 rule", () => {
  assert.deepEqual(releaseTarget(200, 0.2, FIT, CAP), { kind: "free", y: 200 }, "no spring-back to contentFit any more (L2 had one)");
  assert.deepEqual(releaseTarget(FIT + 1, 0, FIT, CAP), { kind: "free", y: FIT + 1 }, "the free range starts right under contentFit");
});

test("releaseTarget: dismiss by a FLICK — only from below contentFit; a flick from the cap stops at contentFit", () => {
  assert.deepEqual(releaseTarget(FIT + 1, FLICK_VY + 0.1, FIT, CAP), { kind: "dismiss" }, "fast downward flick while already below contentFit");
  assert.deepEqual(releaseTarget(30, FLICK_VY + 0.1, FIT, CAP), { kind: "detent", y: FIT }, "a flick down from the cap lands on the NEXT detent, not off the screen");
  assert.deepEqual(releaseTarget(90, -(FLICK_VY + 0.1), FIT, CAP), { kind: "detent", y: 0 }, "a flick up goes to the cap");
  assert.deepEqual(releaseTarget(200, -(FLICK_VY + 0.1), FIT, CAP), { kind: "detent", y: FIT }, "a flick up from a free position goes to contentFit — the next detent up, one step per gesture");
});

test("releaseTarget: above contentFit without a flick, the NEAREST detent — contentFit or cap, nothing free-form up there", () => {
  assert.deepEqual(releaseTarget(59, 0, FIT, CAP), { kind: "detent", y: 0 });
  assert.deepEqual(releaseTarget(61, 0, FIT, CAP), { kind: "detent", y: FIT });
  assert.deepEqual(releaseTarget(-20, 0, FIT, CAP), { kind: "detent", y: 0 }, "an overshoot above the cap springs back to it");
});

test("releaseTarget: the minimum applies only BELOW contentFit — a card shorter than MIN_VISIBLE_PX still rests at contentFit, and has no free range", () => {
  const smallFit = CAP - 60; // a 60px card: contentFit already shows less than MIN_VISIBLE_PX
  assert.deepEqual(releaseTarget(smallFit, 0, smallFit, CAP), { kind: "detent", y: smallFit }, "AT contentFit: rests — the minimum must never dismiss a card for being small");
  assert.deepEqual(releaseTarget(smallFit + 1, 0, smallFit, CAP), { kind: "dismiss" }, "one px below it is under the minimum: the only thing below contentFit for a card this small is closing it");
});

test("releaseTarget: task window (fit = 0) — the cap is its only detent; below it is free until the minimum, or a flick", () => {
  assert.deepEqual(releaseTarget(40, 0, 0, CAP), { kind: "free", y: 40 }, "a task can be pulled down to peek at the pane behind it too");
  assert.deepEqual(releaseTarget(FLOOR + 1, 0, 0, CAP), { kind: "dismiss" });
  assert.deepEqual(releaseTarget(0, 0, 0, CAP), { kind: "detent", y: 0 });
  assert.deepEqual(releaseTarget(5, FLICK_VY + 0.1, 0, CAP), { kind: "dismiss" }, "any downward position below the (zero-width) fit plus a flick");
});

test("velocity: over the last VELOCITY_WINDOW_MS only, px/ms, positive downward", () => {
  const s = [
    { t: 0, y: 0 }, { t: 100, y: 10 },           // old, outside the window
    { t: 200, y: 20 }, { t: 240, y: 60 }, { t: 280, y: 100 },
  ];
  assert.equal(velocity(s), (100 - 20) / (280 - 200), "the sample at least VELOCITY_WINDOW_MS old anchors the window");
  assert.equal(velocity([{ t: 0, y: 0 }]), 0, "one sample: no velocity");
  assert.equal(velocity([]), 0);
  assert.equal(velocity([{ t: 5, y: 0 }, { t: 5, y: 40 }]), 0, "zero elapsed time is not infinite speed");
  assert.equal(velocity([{ t: 0, y: 100 }, { t: 50, y: 0 }]), -2, "upward is negative");
});
