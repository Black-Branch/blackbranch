// Tests for the marathon-timer low-state math (pure, node --test, no DOM).
//
// Run: node --test app/lib/timerLowState.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { timerLowState, formatTimer } from "./timerLowState.ts";

const THRESHOLD = 300; // 5 minutes
// Baseline config for the pre-config-object tests: enabled, linear ramp, default ceiling.
const BASE = { enabled: true, thresholdSec: THRESHOLD, rampRate: 1, glowMax: 0.55 };

test("is off above the threshold", () => {
  const s = timerLowState(600, BASE);
  assert.equal(s.low, false);
  assert.equal(s.intensity, 0);
});

test("switches on exactly at the threshold, at zero intensity", () => {
  const s = timerLowState(THRESHOLD, BASE);
  assert.equal(s.low, true);
  assert.equal(s.intensity, 0, "crossing the line should not jolt — it ramps from 0");
});

test("intensity ramps to 1 as the timer runs out", () => {
  const half = timerLowState(THRESHOLD / 2, BASE);
  assert.equal(half.low, true);
  assert.ok(Math.abs(half.intensity - 0.5) < 1e-9, `expected ~0.5, got ${half.intensity}`);

  const nearly = timerLowState(1, BASE);
  assert.ok(nearly.intensity > 0.99);
});

test("pulse accelerates monotonically as time drops", () => {
  // "increasing rate" — the period must never grow while the clock shrinks.
  let prev = Infinity;
  for (let t = THRESHOLD; t >= 0; t -= 15) {
    const { pulseMs } = timerLowState(t, BASE);
    assert.ok(pulseMs <= prev, `pulse went slower at t=${t} (${pulseMs} > ${prev})`);
    prev = pulseMs;
  }
});

test("at zero the warning treatment turns OFF, it does not peak", () => {
  // Nothing at zero: `timer.js` clamps remaining to 0 but never flips
  // `running` false, so `low === true, intensity === 1` at zero would be a
  // permanent full-opacity page glow and a 380ms strobe on every viewer's
  // screen, with nothing to dismiss it. The alarm is for "time is running out";
  // once it has, there is nothing left to warn about.
  for (const t of [0, -1, -3600]) {
    const s = timerLowState(t, BASE);
    assert.equal(s.low, false, `t=${t} must not read as low`);
    assert.equal(s.glowOpacity, 0, `t=${t} must not glow`);
    assert.equal(s.intensity, 0, `t=${t} must not ramp`);
    assert.equal(s.expired, true, `t=${t} should read as expired`);
  }
});

test("expired and low are mutually exclusive across the whole range", () => {
  for (let t = THRESHOLD + 60; t >= -60; t -= 7) {
    const s = timerLowState(t, BASE);
    assert.ok(!(s.low && s.expired), `t=${t} claimed both low and expired`);
    // Anything the page renders as an effect must be gated on `low`, so an
    // expired timer that still carried glow would be the old bug returning.
    if (s.expired) assert.equal(s.glowOpacity, 0, `expired t=${t} still glowed`);
  }
});

test("rate shapes the ramp without breaking its endpoints", () => {
  // rate > 1 holds back early then accelerates; rate < 1 comes on strong.
  const mid = THRESHOLD / 2;
  const slowStart = timerLowState(mid, { ...BASE, rampRate: 2 }).intensity;
  const linear = timerLowState(mid, { ...BASE, rampRate: 1 }).intensity;
  const fastStart = timerLowState(mid, { ...BASE, rampRate: 0.5 }).intensity;
  assert.ok(slowStart < linear, "rate 2 should lag linear at the midpoint");
  assert.ok(fastStart > linear, "rate 0.5 should lead linear at the midpoint");

  for (const rate of [0.25, 1, 3]) {
    assert.equal(timerLowState(THRESHOLD, { ...BASE, rampRate: rate }).intensity, 0, "still 0 at the threshold");
    assert.ok(timerLowState(0.001, { ...BASE, rampRate: rate }).intensity > 0.99, "still ~1 at the end");
  }
});

test("is off for nonsense inputs rather than rendering NaN", () => {
  for (const [rem, thr] of [[NaN, 300], [300, NaN], [300, 0], [300, -60], [Infinity, 300]]) {
    const s = timerLowState(rem as number, { ...BASE, thresholdSec: thr as number });
    assert.equal(s.low, false, `remaining=${rem} threshold=${thr} should be off`);
    assert.ok(Number.isFinite(s.pulseMs));
  }
});

test("a bad rate falls back to linear instead of poisoning intensity", () => {
  const linear = timerLowState(150, { ...BASE, rampRate: 1 }).intensity;
  for (const bad of [0, -2, NaN, Infinity]) {
    assert.equal(timerLowState(150, { ...BASE, rampRate: bad }).intensity, linear, `rate ${bad}`);
  }
});

// ── Fund the Night: a negative remainingSec (the deficit) ──────────────────
//
// timer.js can broadcast a NEGATIVE `remainingSec` while a night is active
// (and `night.gapSec`, its restatement) — the deficit has no floor by design
// (the overlay renders it as a real number). The SITE pill is a different
// surface with a different job: it floors at 0:00:00 and does not render the
// deficit at all (that's the overlay's fuse, not this pill's). The generic
// negative-input cases above (`-1`, `-3600`) already exercise this path —
// these two pin it explicitly under its Fund the Night name so the connection
// is not just an accident of overlapping test ranges.
test("Fund the Night: a night's deficit (negative remainingSec) is still expired/off, never warns", () => {
  const s = timerLowState(-1800, BASE); // 30 minutes into a deficit
  assert.equal(s.low, false, "a deficit must not read as the low-timer warning state");
  assert.equal(s.expired, true, "a deficit reads as expired, same as remaining=0");
  assert.equal(s.glowOpacity, 0);
  assert.equal(s.intensity, 0);
});

test("Fund the Night: formatTimer floors a deficit at 0:00, it does not count up or go negative", () => {
  for (const deficitSec of [-1, -300, -1800, -36000]) {
    assert.equal(formatTimer(deficitSec), "0:00", `deficit ${deficitSec}s must floor, not display negative`);
  }
});

// ── formatTimer ──────────────────────────────────────────────────────────────

test("formatTimer matches the overlay's shape", () => {
  assert.equal(formatTimer(0), "0:00");
  assert.equal(formatTimer(9), "0:09");
  assert.equal(formatTimer(69), "1:09");
  assert.equal(formatTimer(599), "9:59");
  assert.equal(formatTimer(3600), "1:00:00");
  assert.equal(formatTimer(3661), "1:01:01");
  assert.equal(formatTimer(36000), "10:00:00");
});

test("formatTimer clamps negatives and survives junk", () => {
  assert.equal(formatTimer(-5), "0:00");
  assert.equal(formatTimer(NaN), "0:00");
  assert.equal(formatTimer(12.7), "0:13", "ceils — see the OBS-parity test below");
});

test("formatTimer ceils, matching the OBS overlay exactly", () => {
  // This is a CROSS-SURFACE contract, not a formatting preference.
  //
  // The on-stream timer overlay (timer.html) renders
  // Math.ceil(liveRemaining()). Both it and the site interpolate from the same
  // `timerState` anchor, so any rounding disagreement is a permanent, constant
  // offset — not jitter: flooring here puts the site exactly ONE SECOND behind
  // the timer viewers see on stream, and whole-second inputs cannot show it.
  //
  // Fractional inputs are the only ones that can catch it. Keep them.
  assert.equal(formatTimer(0.1), "0:01", "any time left must not display as 0:00");
  assert.equal(formatTimer(59.5), "1:00");
  assert.equal(formatTimer(3599.4), "1:00:00", "the exact case where the two displays disagreed");
  assert.equal(formatTimer(0), "0:00", "and only true zero reads as 0:00");

  // Re-derive the overlay's expression rather than restating the expectation.
  const overlayFormat = (sec: number) => {
    const total = Math.ceil(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };
  for (const t of [0, 0.3, 1.9, 59.99, 60, 61.2, 3599.999, 3600, 7322.5, 36000.1]) {
    assert.equal(formatTimer(t), overlayFormat(t), `disagreed with the overlay at ${t}s`);
  }
});

// ── v81: config-driven, not constant-driven ─────────────────────────────────

const CFG = { enabled: true, thresholdSec: 300, rampRate: 1, glowMax: 0.55 };

test("config object drives the same curve the constants did", () => {
  const s = timerLowState(150, CFG);
  assert.equal(s.low, true);
  assert.ok(Math.abs(s.intensity - 0.5) < 1e-9);
});

test("disabled config is off no matter how low the clock is", () => {
  // The broadcaster's master switch. Zero seconds left must still read as off.
  for (const remaining of [299, 60, 1, 0, -5]) {
    const s = timerLowState(remaining, { ...CFG, enabled: false });
    assert.equal(s.low, false, `remaining=${remaining} should be off`);
    assert.equal(s.glowOpacity, 0);
  }
});

test("glowOpacity is intensity scaled by the ceiling", () => {
  const s = timerLowState(150, { ...CFG, glowMax: 0.4 });
  assert.ok(Math.abs(s.glowOpacity - 0.2) < 1e-9, `got ${s.glowOpacity}`);
  // Highest just BEFORE zero — at zero the treatment is off entirely.
  assert.ok(timerLowState(0.001, { ...CFG, glowMax: 0.4 }).glowOpacity > 0.39);
  assert.equal(timerLowState(0, { ...CFG, glowMax: 0.4 }).glowOpacity, 0, "off at zero");
});

test("a zero ceiling suppresses the glow but keeps the timer state low", () => {
  const s = timerLowState(60, { ...CFG, glowMax: 0 });
  assert.equal(s.low, true, "timer still recolours");
  assert.equal(s.glowOpacity, 0, "but no page glow");
});
