"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatSocket, type ChatSocketEvent } from "./useChatSocket";
import type { TimerEffectsConfig } from "./timerLowState";

// Marathon-timer state for the web, from the `timerState` broadcast frame.
//
// The frame is contract-tested (wsFrames.ts) and also feeds the OBS overlay;
// this hook is the web's consumer.
//
// stream-api broadcasts on every change plus a periodic heartbeat, so between
// frames we interpolate locally: a running timer must visibly tick, not step
// once a heartbeat. `deltaSec: 0` marks the heartbeat and does NOT mean "no
// change" (see the frame's doc comment) — we read `remainingSec`, never delta.

export type StreamTimer = {
  /** False until the first frame arrives — render the old label until then. */
  known: boolean;
  running: boolean;
  remainingSec: number;
  /** Server-derived: at the cap ceiling or the zero floor. */
  locked: boolean;
  lockAtZero: boolean;
  /** The broadcaster's effects curve, off the same frame. */
  effects: TimerEffectsConfig;
  /** Last NON-ZERO deltaSec, for the +/- popup. `at` is a timestamp so two
   *  identical deltas in a row still read as two separate events. */
  lastDelta: { sec: number; at: number } | null;
};

// Used until the first frame lands, and as the shape a pre-v81 stream-api would
// leave absent. Mirrors timer.js's own defaults.
const DEFAULT_EFFECTS: TimerEffectsConfig = {
  enabled: true, thresholdSec: 300, rampRate: 1.6, glowMax: 0.55,
};

const INITIAL: StreamTimer = {
  known: false, running: false, remainingSec: 0, locked: false,
  lockAtZero: false, effects: DEFAULT_EFFECTS, lastDelta: null,
};

export function useStreamTimer(): StreamTimer {
  const [timer, setTimer] = useState<StreamTimer>(INITIAL);
  // Anchor = the last authoritative frame plus when it landed, so the local
  // tick derives from elapsed wall-clock instead of accumulating drift by
  // subtracting 1 per interval (which skews on a throttled/backgrounded tab).
  const anchor = useRef<{ remainingSec: number; at: number; running: boolean } | null>(null);

  const onEvent = useCallback((data: ChatSocketEvent) => {
    if (data.type !== "timerState") return;
    anchor.current = { remainingSec: data.remainingSec, at: Date.now(), running: data.running };
    setTimer((prev) => ({
      known: true,
      running: data.running,
      // Floored at the write: `remainingSec` can arrive negative (a night's
      // deficit — v111, no floor on the wire by design). The site never
      // renders the deficit — that's the overlay's job — so state never
      // carries a raw negative even briefly between here and the next
      // interpolation tick (which already floors, but only 250ms later).
      remainingSec: Math.max(0, data.remainingSec),
      locked: data.locked,
      lockAtZero: data.lockAtZero,
      effects: {
        enabled: data.lowPulseEnabled,
        thresholdSec: data.lowThresholdSec,
        rampRate: data.lowRampRate,
        glowMax: data.lowGlowMax,
      },
      // deltaSec === 0 marks the 15s heartbeat, NOT "no change" (see the frame's
      // doc comment) — carry the previous delta through rather than clearing it
      // on every heartbeat.
      lastDelta: data.deltaSec !== 0
        ? { sec: data.deltaSec, at: Date.now() }
        : prev.lastDelta,
    }));
  }, []);

  useChatSocket(onEvent);

  useEffect(() => {
    // Only tick while the timer is actually counting down — a paused or absent
    // timer costs nothing (deliberate: idle render work is what makes phones
    // hot, and this sits on the always-mounted player bar).
    if (!timer.known || !timer.running) return;
    const id = setInterval(() => {
      // No display to update in a hidden tab; the next visible tick (≤250ms
      // away) recomputes from the wall-clock anchor, so nothing drifts.
      if (document.hidden) return;
      const a = anchor.current;
      if (!a || !a.running) return;
      const next = Math.max(0, a.remainingSec - (Date.now() - a.at) / 1000);
      setTimer((prev) =>
        Math.floor(prev.remainingSec) === Math.floor(next)
          ? prev // same displayed second — skip the re-render
          : { ...prev, remainingSec: next } // spread: never drop the config on a tick
      );
    }, 250);
    return () => clearInterval(id);
  }, [timer.known, timer.running]);

  return timer;
}
