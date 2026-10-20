// WHEP connection-escalation policy — when a WebRTC player should retry, when it
// should stop and hand the viewer the choice, and (crucially) when it should do
// NOTHING. ("fallback" used to mean "switch to HLS by yourself"; since the
// NO AUTOMATIC DEMOTION rule in StreamplaceThinPlayer it means "stop and ask".)
//
// WHY THIS IS A SEPARATE, PURE MODULE. It was inline in StreamplaceThinPlayer,
// where it could not be tested — you cannot exercise a WebRTC state machine
// against an offline stream. Live behaviour proved the policy wrong (viewers on
// a WORKING beta player were demoted mid-stream), and the bug was a single
// clause in a `||`. Pulling the decision out means the policy is now unit-tested
// even though the transport still is not.
//
// THE BUG THIS FIXES. The old code read:
//     if (st === "failed" || st === "disconnected" || st === "closed") …escalate
// but per the WebRTC spec `disconnected` is TRANSIENT, not terminal: it fires on
// brief network hiccups, wifi roaming, and slow ICE consent checks, and commonly
// recovers to `connected` on its own within a few seconds. `failed` is the
// terminal state. Treating them alike tore down working connections, and after
// MAX_RECONNECTS demoted the viewer to HLS — with no automatic path back, so a
// single blip stranded them on the compatibility player for the whole session.
//
// The policy now: `disconnected` starts a GRACE window and nothing else. If the
// connection comes back, we never even tell the user. Only `failed`, or grace
// expiring while still not connected, escalates.

/**
 * Is the picture actually moving right now?
 *
 * THE RULE THIS ENCODES: no failure state may be shown while frames advance.
 *
 * The demotions this module was written to stop were firing on WORKING playback
 * — `disconnected` is a control-plane state (a missed ICE consent check) and
 * media routinely flows straight through it. Removing the auto-demotion without
 * this guard would just change the symptom from "silently moved to another
 * player" to "full-screen 'Can't connect' painted over live video", which is
 * worse: a transport swap is at least watchable.
 *
 * So connection bookkeeping never gets the last word — the video element does.
 * `timeupdate` fires only on real progress, so a stale timestamp means genuinely
 * stalled; readyState < HAVE_CURRENT_DATA means there is nothing to show anyway.
 *
 * @param lastProgressAt wall-clock ms of the last `timeupdate`
 */
export function playbackIsAdvancing(input: {
  paused: boolean;
  readyState: number;
  lastProgressAt: number;
  now: number;
  /** How stale progress may be before playback counts as stalled. */
  staleMs?: number;
}): boolean {
  const { paused, readyState, lastProgressAt, now, staleMs = 3000 } = input;
  if (paused) return false;
  if (readyState < 2) return false; // HAVE_CURRENT_DATA
  return now - lastProgressAt < staleMs;
}

/** What the player should do in response to a connection-state change. */
export type EscalationAction =
  /** Do nothing — transient, may self-heal. Start/keep the grace timer. */
  | { kind: "wait"; graceMs: number }
  /** Tear down and retry over WebRTC (we know WebRTC works here — it connected). */
  | { kind: "reconnect" }
  /** Stop retrying WebRTC for this session and show the viewer the choice —
   *  the player's "failed" panel: compatibility mode / try again / the embed. */
  | { kind: "fallback" }
  /** Nothing to do (connected, or a teardown we initiated). */
  | { kind: "none" };

/**
 * How long a `disconnected` connection is given to heal itself before we treat
 * it as a real failure. ICE consent checks run on a ~5s cadence, so a window
 * shorter than that reports failures the transport was about to recover from.
 */
// @test-only whepEscalation.test.ts asserts against the grace window.
export const DISCONNECT_GRACE_MS = 6000;

// The reconnect ladder. One ~8-minute node-side blip can hit many viewers; a
// short ladder — four tries at 2/4/6/8 s, each behind the 9 s connect timeout
// — burns out in about a minute and leaves "Can't connect" on screen for the
// rest of it. The waits grow and then hold at 30 s, and the budget is ten
// attempts: with the connect timeout on each, roughly five minutes of
// "Reconnecting…" before the viewer is handed the choice. Long enough to
// outlast a short relay outage, short enough to still end somewhere. `attempt`
// is the 1-based count of the retry being scheduled: the ramp for the first
// four, the hold for the rest.
export const MAX_RECONNECTS = 10;
const RECONNECT_RAMP_MS = [2000, 4000, 8000, 15000];
const RECONNECT_HOLD_MS = 30000;
export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_RAMP_MS[Math.max(attempt, 1) - 1] ?? RECONNECT_HOLD_MS;
}

export type EscalationInput = {
  /** RTCPeerConnection.connectionState */
  state: RTCPeerConnectionState;
  /** Has this session ever reached "connected"? */
  everConnected: boolean;
  /** Consecutive failed reconnect attempts so far. */
  retryCount: number;
  /** Max consecutive retries before giving up on WebRTC. */
  maxReconnects: number;
  /** True when WE are tearing the connection down (unmount, mode switch). */
  aborted: boolean;
};

/**
 * Decide what a connection-state change means. Pure: no timers, no refs, no DOM.
 *
 * Ordering matters — `aborted` is checked first, because a teardown we initiated
 * drives the state to "closed" and must never be read as a failure.
 */
export function escalationFor(input: EscalationInput): EscalationAction {
  const { state, everConnected, retryCount, maxReconnects, aborted } = input;

  if (aborted) return { kind: "none" };
  if (state === "connected" || state === "new" || state === "connecting") return { kind: "none" };

  // TRANSIENT. The whole point of this module: wait, do not escalate.
  if (state === "disconnected") return { kind: "wait", graceMs: DISCONNECT_GRACE_MS };

  // "closed" without `aborted` means the far side closed it; treat as failed.
  if (state === "failed" || state === "closed") {
    // Never connected => WebRTC does not work on this network (blocked UDP,
    // hostile proxy). Retrying the same transport will not help.
    if (!everConnected) return { kind: "fallback" };
    return retryCount >= maxReconnects ? { kind: "fallback" } : { kind: "reconnect" };
  }

  return { kind: "none" };
}

/**
 * Called when the grace window expires and the connection has NOT recovered.
 * At that point a `disconnected` is treated exactly like a `failed`.
 */
export function escalationAfterGrace(
  input: Omit<EscalationInput, "state">
): EscalationAction {
  return escalationFor({ ...input, state: "failed" });
}
