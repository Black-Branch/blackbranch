// When a crowd auto-pin comes down. Pure (its clock, timer, settings and the expiry itself are
// passed in), so autoPin.test.ts drives it with a fake clock.
import { autoPinWaitMs, type AutoPinRules } from "./votePolicy.ts";

export type AutoPinExpiryDeps = {
  nowMs: () => number;
  /** The CURRENT settings, read again each time the timer fires. */
  rules: () => AutoPinRules;
  setTimer: (fn: () => void, ms: number) => void;
  /** Takes the pin down if it is still the active crowd pin. */
  expire: (id: number) => Promise<unknown>;
};

/** Arms the timer for one crowd pin. If the streamer raised the minutes while it was up, the
 *  timer finds it not yet due and waits again: it never drops a pin early, and it never leaves a
 *  pin up for good. A restart loses the timer; GET /api/chat/pin then expires the pin lazily. */
export function scheduleAutoPinExpiry(id: number, createdAtMs: number, deps: AutoPinExpiryDeps): void {
  const arm = () => {
    const wait = autoPinWaitMs(createdAtMs, deps.nowMs(), deps.rules());
    if (wait > 0) { deps.setTimer(arm, wait); return; }
    deps.expire(id).catch((e) => console.error("[chat/pin] auto-pin expiry failed:", (e as Error).message));
  };
  arm();
}
