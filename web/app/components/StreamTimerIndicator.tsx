"use client";

import { useEffect, useState } from "react";
import { useStreamTimer } from "@/app/lib/useStreamTimer";
import { timerLowState, formatTimer, TIMER_LOW_OFF } from "@/app/lib/timerLowState";

// The marathon timer in the player top bar, plus the "time added" popup that
// comes with it.
//
// @parked — the on-site timer display is switched off; the OBS overlays carry
// the timer. Kept, unmounted, so it can come back intact.
//
// The threshold and ramp rate are NOT constants here — they arrive on the
// `timerState` frame from stream.timer_state, so a mod can tune them
// live and the OBS overlay reads the same numbers.
//
// Label and popup share ONE `useStreamTimer()` — the hook opens a WebSocket,
// so splitting them into separate mounted components would open two.

/** Mirrors the OBS overlay's delta popup: shows for 2.2s after a non-zero
 *  deltaSec, then fades. Mounted with a key on `at`, so two identical deltas in
 *  a row still read as two separate events. */
function DeltaPopup({ delta }: { delta: { sec: number; at: number } }) {
  // Starts visible and hides itself. No setState in the effect body — the
  // component is keyed on `delta.at`, so a new event remounts it fresh rather
  // than needing to be reset.
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 2200);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;
  const positive = delta.sec >= 0;
  return (
    <span
      aria-live="polite"
      className={`timer-delta-pop text-2xs font-semibold tabular-nums ${
        positive ? "text-teal-300" : "text-red-400"
      }`}
    >
      {positive ? "+" : "−"}
      {formatTimer(Math.abs(delta.sec))}
    </span>
  );
}

// @parked — the on-site timer display is switched off; the OBS overlays carry
// the timer. Kept, unmounted, so it can come back intact — deleting it would
// take the "time added" popup with it, and that is the half nothing else on
// the site renders.
export default function StreamTimerIndicator({
  live,
  fallback,
}: {
  /**
   * This hides the timer when OFFLINE — the inverse of hiding it while LIVE,
   * which `timerVisibility.test.ts` guards against and must keep passing. A
   * marathon clock counting down over a dead player is noise; the bar says
   * OFFLINE there instead.
   */
  live: boolean;
  fallback: React.ReactNode;
}) {
  const timer = useStreamTimer();

  // No timer state yet, or a timer at rest that has never been set — keep the
  // bar exactly as it was rather than showing a meaningless 0:00.
  if (!live || !timer.known || (!timer.running && timer.remainingSec <= 0 && !timer.locked)) {
    return <>{fallback}</>;
  }

  const low = timer.running
    ? timerLowState(timer.remainingSec, timer.effects)
    : TIMER_LOW_OFF;

  return (
    <>
      <span
        title={
          timer.locked
            ? "Marathon timer — locked"
            : timer.running
              ? "Marathon timer — time remaining"
              : "Marathon timer — paused"
        }
        // Expired shares the red but NOT the pulse: at 00:00 the colour is a
        // state readout ("the marathon ended"), not a warning to act on.
        className={`flex items-center gap-1.5 text-xs font-semibold tabular-nums transition-colors ${
          low.low || low.expired ? "text-red-400" : "text-secondary"
        } ${low.low ? "timer-low-pulse" : ""}`}
        style={low.low ? ({ "--timer-pulse-ms": `${low.pulseMs}ms` } as React.CSSProperties) : undefined}
      >
        <span
          className={`w-2 h-2 rounded-full ${
            low.low || low.expired ? "bg-red-500" : timer.running ? "bg-amber-400" : "bg-secondary"
          }`}
        />
        {formatTimer(timer.remainingSec)}
        {timer.locked && <span className="text-2xs text-secondary">🔒</span>}
      </span>
      {timer.lastDelta && <DeltaPopup key={timer.lastDelta.at} delta={timer.lastDelta} />}
    </>
  );
}
