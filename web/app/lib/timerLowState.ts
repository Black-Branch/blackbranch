// Marathon-timer "running low" math — the pure half of the video-bar timer.
//
// The timer replaces the OFFLINE label in the player top bar; when it drops
// under a threshold the page picks up warning treatment (the timer pulses AND
// the page edges glow, both intensifying as it counts down). Everything
// derived from "how much time is left" lives here so it is testable under
// node --test without a DOM, and so the visual layer is a pure function of one
// number instead of scattered conditionals.

export type TimerLowState = {
  /** Is the timer inside the warning window at all? */
  low: boolean;
  /**
   * The clock has reached zero — the marathon is over. Deliberately NOT a
   * flavour of `low`: `low` means "warn, time is running out", and once it has
   * run out there is nothing left to warn about. Callers should render this as
   * a static state readout (a red 00:00), never as an effect.
   */
  expired: boolean;
  /** 0 at the threshold → 1 at zero. Drives glow opacity and pulse rate. */
  intensity: number;
  /** Pulse period in ms — shorter as time runs out ("increasing rate"). */
  pulseMs: number;
  /** Ready-to-render page-glow opacity: intensity × the ceiling. */
  glowOpacity: number;
};

/** The broadcaster-owned curve, delivered on the `timerState` frame (v81) so the
 *  site and the OBS overlay read identical values. Previously constants in this
 *  bundle, which meant "adjustable" required a deploy. */
export type TimerEffectsConfig = {
  /** Master switch (`low_pulse_enabled`) — off disables the whole treatment. */
  enabled: boolean;
  thresholdSec: number;
  rampRate: number;
  glowMax: number;
};

/** Pulse period at the threshold (slow) and at zero (urgent). The ramp between
 *  them is what reads as accelerating. */
const PULSE_SLOW_MS = 1600;
const PULSE_FAST_MS = 380;

export const TIMER_LOW_OFF: TimerLowState = {
  low: false, expired: false, intensity: 0, pulseMs: PULSE_SLOW_MS, glowOpacity: 0,
};

/** Zero reached. `pulseMs` stays at the fast end purely so the ramp remains
 *  monotonic as the clock crosses zero — nothing pulses while `low` is false. */
const TIMER_EXPIRED: TimerLowState = {
  low: false, expired: true, intensity: 0, pulseMs: PULSE_FAST_MS, glowOpacity: 0,
};

/**
 * @param remainingSec  seconds left on the timer (from the `timerState` frame)
 * @param cfg           the broadcaster's curve, off the same frame
 */
export function timerLowState(remainingSec: number, cfg: TimerEffectsConfig): TimerLowState {
  const { enabled, thresholdSec, rampRate, glowMax } = cfg;
  const ceiling = Number.isFinite(glowMax) ? Math.min(1, Math.max(0, glowMax)) : 0;
  if (!enabled) return TIMER_LOW_OFF;
  if (!Number.isFinite(remainingSec) || !Number.isFinite(thresholdSec) || thresholdSec <= 0) {
    return TIMER_LOW_OFF;
  }
  // At or below zero the warning treatment turns OFF, it does not peak.
  //
  // The timer sits at 00:00 indefinitely (`timer.js` clamps `liveRemaining()`
  // to 0 but never flips `running` false), so peaking at zero would be a
  // permanent page glow at the ceiling plus a 380ms strobe, with no way to
  // dismiss it — a stuck alarm on every viewer's screen for the rest of the
  // stream.
  //
  // `expired` still fires so the label can read as ended rather than as any
  // other value — see the type. Gated behind `enabled` above, so the
  // broadcaster's master switch really does mean "no timer treatment at all".
  if (remainingSec <= 0) return TIMER_EXPIRED;
  if (remainingSec > thresholdSec) return TIMER_LOW_OFF;

  const linear = (thresholdSec - remainingSec) / thresholdSec; // 0 → 1
  const safeRate = Number.isFinite(rampRate) && rampRate > 0 ? rampRate : 1;
  const intensity = Math.min(1, Math.max(0, Math.pow(linear, safeRate)));
  return {
    low: true,
    expired: false,
    intensity,
    pulseMs: Math.round(PULSE_SLOW_MS + (PULSE_FAST_MS - PULSE_SLOW_MS) * intensity),
    glowOpacity: intensity * ceiling,
  };
}

/**
 * `H:MM:SS` past an hour, else `M:SS`. Negative clamps to zero.
 *
 * CEIL, not floor, and that is the whole point: the OBS timer overlay
 * (timer.html) renders `Math.ceil(liveRemaining())`, and both surfaces
 * interpolate from the same `timerState` anchor. Flooring here would put the
 * site exactly one second BEHIND the on-stream timer at all times.
 *
 * Ceil is also the right countdown convention on its own: flooring shows
 * `0:00` for a full second before the clock is actually zero.
 *
 * If the overlay's rounding ever changes, change it here in the same breath.
 */
export function formatTimer(remainingSec: number): string {
  const total = Math.max(0, Math.ceil(Number.isFinite(remainingSec) ? remainingSec : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
