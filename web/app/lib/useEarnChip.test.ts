// The earn chip's QUEUE, which is the only part of it with behaviour.
//
// Run: node --test --experimental-strip-types app/lib/useEarnChip.test.ts
//
// The look is CSS and the wiring is a heartbeat; what can actually go wrong
// here is the hand-off between chips — awards dropped, chips overlapping, a
// timer left running with nothing to show, or a repeat award that never
// animates because React reused the element.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  EARN_CHIP_MS, peekEarnChip, pushEarnChips, resetEarnChips,
} from "./useEarnChip.ts";

import { readFileSync } from "node:fs";
import { join } from "node:path";

beforeEach(() => resetEarnChips());

test("an empty or all-zero push does not disturb the store", (t) => {
  // Most beats award nothing. If those still touched the store, every idle
  // viewer would re-render once a minute to show the same nothing.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([]);
  assert.equal(peekEarnChip().points, 0);
  assert.equal(peekEarnChip().seq, 0, "seq must not advance for a no-op push");
  pushEarnChips([{ kind: "earn_chat", points: 0 }]);
  assert.equal(peekEarnChip().points, 0);
  assert.equal(peekEarnChip().seq, 0);
});

test("the first chip shows immediately, not after a delay", (t) => {
  // A chip that waited its own duration before appearing would land ~1.5s
  // after the action, which is most of the connection it exists to draw.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([{ kind: "earn_chat", points: 1 }]);
  assert.equal(peekEarnChip().points, 1);
});

test("a window of awards COALESCES into one chip, not a run of them", (t) => {
  // The chip does not name what earned the Qorm, so "+5q" then "+1q" then "+2q"
  // carries exactly the information of "+8q" — split across three restarts of
  // the same animation, which reads as stuttering, and three chances to
  // overflow a narrow composer.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([
    { kind: "earn_first", points: 5 },
    { kind: "earn_chat", points: 1 },
    { kind: "earn_upvote", points: 2 },
  ]);
  assert.equal(peekEarnChip().points, 8, "one chip carrying the whole window");
  t.mock.timers.tick(EARN_CHIP_MS);
  assert.equal(peekEarnChip().points, 0, "and then nothing — no follow-ups to play out");
});

test("nothing is LOST when awards land while a chip is showing", (t) => {
  // Coalescing must not become dropping. The second window waits its turn and
  // is announced in full.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([{ kind: "earn_first", points: 5 }]);
  assert.equal(peekEarnChip().points, 5);
  t.mock.timers.tick(EARN_CHIP_MS / 2);
  pushEarnChips([{ kind: "earn_vote", points: 1 }]);
  pushEarnChips([{ kind: "earn_upvote", points: 2 }]);
  assert.equal(peekEarnChip().points, 5, "the running chip keeps its slot and its value");
  t.mock.timers.tick(EARN_CHIP_MS / 2);
  assert.equal(peekEarnChip().points, 3, "both later awards arrive together");
  t.mock.timers.tick(EARN_CHIP_MS);
  assert.equal(peekEarnChip().points, 0);
});

test("the visible number never changes under the viewer", (t) => {
  // Adding to the chip on screen would be the obvious way to coalesce and is
  // wrong: a value that ticks up mid-animation reads as a rendering glitch
  // rather than as more Qorm.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([{ kind: "earn_chat", points: 1 }]);
  const shown = peekEarnChip();
  pushEarnChips([{ kind: "earn_vote", points: 1 }]);
  assert.deepEqual(peekEarnChip(), shown, "same value AND same seq — nothing re-rendered");
});

test("the sequence number advances per chip, so a repeat still animates", (t) => {
  // React keys the element on seq. Two "+1q" awards in a row are different
  // events; without a changing key the element is reused and the second one
  // appears as a chip that never moved.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([{ kind: "earn_chat", points: 1 }]);
  const first = peekEarnChip().seq;
  t.mock.timers.tick(EARN_CHIP_MS / 2);
  pushEarnChips([{ kind: "earn_chat", points: 1 }]);
  t.mock.timers.tick(EARN_CHIP_MS / 2);
  assert.equal(peekEarnChip().points, 1, "premise: the same amount again");
  assert.notEqual(peekEarnChip().seq, first, "but a different key");
});

test("a drained store leaves no timer running", (t) => {
  // A store that keeps rearming with nothing to show wakes the tab forever.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pushEarnChips([{ kind: "earn_chat", points: 1 }]);
  t.mock.timers.tick(EARN_CHIP_MS);
  assert.equal(peekEarnChip().points, 0);
  t.mock.timers.tick(EARN_CHIP_MS * 10);
  assert.equal(peekEarnChip().points, 0);
  // And a later push must still start cleanly rather than waiting on a
  // phantom timer that will never fire.
  pushEarnChips([{ kind: "earn_vote", points: 1 }]);
  assert.equal(peekEarnChip().points, 1);
});

test("a negative or malformed award cannot subtract from the total", () => {
  // The server filters these, but the chip must not be the thing that trusts
  // it — a negative would render "+-3q".
  pushEarnChips([{ kind: "earn_chat", points: -3 } as never, { kind: "earn_vote", points: 2 }]);
  assert.equal(peekEarnChip().points, 2);
});

// ── The chip's CSS ──────────────────────────────────────────────────────────
//
// Asserted as source text because it IS the code here — the animation lives
// entirely in globals.css, and the defect below was invisible to every other
// kind of test: zero dropped frames, correct final position, correct duration.

const GLOBALS = readFileSync(join(import.meta.dirname, "..", "globals.css"), "utf8");

/** The `@keyframes <name>` block, or null. Sliced rather than parsed to keep
 *  this test dependency-free. `after` lets the caller reach the copy inside the
 *  reduced-motion media query rather than the base one. */
function keyframes(name: string, after = 0): string | null {
  const at = GLOBALS.indexOf(`@keyframes ${name} {`, after);
  if (at < 0) return null;
  return GLOBALS.slice(at, GLOBALS.indexOf("\n}", at) + 2);
}

/** Keyframe stops as [percent, value] for one property, in source order. */
function stops(kf: string, prop: string): { pct: number; value: string; eased: boolean }[] {
  const out: { pct: number; value: string; eased: boolean }[] = [];
  const re = new RegExp(`(from|to|\\d+)%?\\s*\\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(kf)) !== null) {
    const head = m[1]!;
    const body = m[2]!;
    const v = new RegExp(`${prop}:\\s*([^;]+);`).exec(body);
    if (!v) continue;
    out.push({
      pct: head === "from" ? 0 : head === "to" ? 100 : Number(head),
      value: v[1]!.trim(),
      eased: /animation-timing-function:/.test(body),
    });
  }
  return out;
}

test("every MOVING segment declares its own easing", () => {
  // BUG ONE, and the reason this whole section exists.
  // `animation-timing-function` is applied per SEGMENT, never to the animation
  // as a whole. A multi-stop keyframe block inheriting one curve runs that
  // curve once per segment, decelerating to a near-stop and re-accelerating at
  // every boundary. Measured: -0.1796 velocity jump at the 72% stop, 8x the
  // next largest, with ZERO dropped frames — a performance trace finds
  // nothing.
  //
  // The rule is NOT "use from/to" — that would block the correct fix: a
  // segment whose value does not CHANGE cannot suffer from this, which is what
  // makes the hold below safe. The real rule is the one asserted here.
  for (const [name, prop] of [["earn-chip-rise", "transform"], ["earn-chip-fade", "opacity"]] as const) {
    const kf = keyframes(name);
    assert.ok(kf, `premise: ${name} exists`);
    const st = stops(kf!, prop);
    assert.ok(st.length >= 2, `${name} needs at least two stops, got ${st.length}`);
    for (let i = 0; i < st.length - 1; i++) {
      if (st[i]!.value === st[i + 1]!.value) continue; // a hold — nothing to ease
      assert.ok(
        st[i]!.eased,
        `${name}: the segment at ${st[i]!.pct}% CHANGES ${prop} and does not declare its own ` +
          "animation-timing-function — it will inherit one curve per segment and hitch at the boundary"
      );
    }
  }
});

test("the chip HOLDS STILL for most of its life", () => {
  // BUG TWO, which the fix for bug one causes. Collapsing the animation to one
  // from/to segment removes the discontinuity and makes it worse: 11.85px of
  // travel spread across 1500ms is ~one whole pixel every 127ms. Measured 137
  // distinct sub-pixel positions but only THIRTEEN whole-pixel ones — however
  // smooth the maths, the rendered chip steps a pixel at a time and the eye
  // tracks it. Both versions read as jittery.
  //
  // The shape that solves both is move fast, hold perfectly still, leave. A
  // static hold has nothing to quantize during the part actually being read.
  const kf = keyframes("earn-chip-rise");
  const st = stops(kf!, "transform");
  let held = 0;
  for (let i = 0; i < st.length - 1; i++) {
    if (st[i]!.value === st[i + 1]!.value) held += st[i + 1]!.pct - st[i]!.pct;
  }
  assert.ok(held >= 50,
    `the transform is static for only ${held}% of the animation — a slow continuous drift ` +
      "quantizes to whole pixels and reads as jitter (measured: 73% held is what fixed it)");
});

test("the moving segments are SHORT, not a slow creep", () => {
  // 70-350ms is where every published motion system puts a transition; the
  // broken version moved for the entire 1500ms at ~8px/sec. Expressed as a
  // share of the duration so it stays true if EARN_CHIP_MS changes.
  const st = stops(keyframes("earn-chip-rise")!, "transform");
  for (let i = 0; i < st.length - 1; i++) {
    if (st[i]!.value === st[i + 1]!.value) continue;
    const span = st[i + 1]!.pct - st[i]!.pct;
    assert.ok(span <= 25,
      `a moving segment spans ${span}% of the animation — motion that slow steps visibly`);
  }
});

test("reduced motion keeps the centring translate, and drops only the rise", () => {
  // The chip is anchored with `left: 50%` and centred by the transform. A
  // reduced-motion rule that zeroed the transform — the obvious way to write
  // "no movement" — would shove every chip half its own width to the right,
  // for exactly the users who asked for less movement.
  const at = GLOBALS.indexOf("@media (prefers-reduced-motion: reduce)", GLOBALS.indexOf("@keyframes earn-chip-rise"));
  assert.ok(at > 0, "premise: the chip has a reduced-motion override");
  const kf = keyframes("earn-chip-rise", at);
  assert.ok(kf, "the override must REDEFINE the rise keyframes");
  const steps = kf!.match(/transform: [^;]+;/g) ?? [];
  assert.ok(steps.length >= 2, `expected a transform per stop, got ${steps.length}`);
  for (const step of steps) {
    assert.match(step, /translateX\(-50%\)/, `${step} must keep the horizontal centring`);
    assert.doesNotMatch(step, /translateY|,\s*-?\d/, `${step} must not carry vertical motion`);
  }
});

test("reduced motion does NOT delete the fade", () => {
  // Reduce, not remove — WebKit's own guidance models SUBSTITUTING a
  // cross-fade rather than deleting motion. And `animation: none` would leave
  // the chip painted at full opacity forever, since nothing unmounts it.
  const after = GLOBALS.indexOf("@media (prefers-reduced-motion: reduce)", GLOBALS.indexOf("@keyframes earn-chip-rise"));
  const block = GLOBALS.slice(after, after + 1200);
  assert.ok(!/\.earn-chip\s*\{[^}]*animation:\s*none/.test(block),
    "killing the animation outright would strand the chip on screen at full opacity");
  assert.equal(keyframes("earn-chip-fade", after), null,
    "the fade must be left ALONE under reduced motion — it is the substitution, not the offence");
});

test("the chip's duration is NOT restated in CSS", () => {
  // EarnChip.tsx supplies it inline from EARN_CHIP_MS, the same constant the
  // store advances on. A duration written here too would drift, and the
  // failure is silent: chips would overlap or leave a gap, and both look like
  // a timing glitch rather than a stale number.
  const rule = GLOBALS.slice(GLOBALS.indexOf(".earn-chip {"), GLOBALS.indexOf("}", GLOBALS.indexOf(".earn-chip {")));
  assert.doesNotMatch(rule, /animation-duration|animation:\s/,
    "the .earn-chip rule must set name/timing/fill only — the duration comes from EARN_CHIP_MS");
  assert.match(rule, /animation-name: earn-chip-rise, earn-chip-fade/,
    "both animations must be on the element, or one property stops animating entirely");
});
