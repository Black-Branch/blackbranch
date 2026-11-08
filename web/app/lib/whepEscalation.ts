// WHEP connection-escalation policy — when a WebRTC player should retry, when it
// should stop and hand the viewer the choice, and (crucially) when it should do
// NOTHING. ("fallback" means "stop and ask", never "switch to HLS by yourself":
// the NO AUTOMATIC DEMOTION rule in StreamplaceThinPlayer.)
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

// The reconnect ladder. The waits grow and then hold at 30 s. `attempt` is the
// 1-based count of the retry being scheduled: the ramp for the first four, the
// hold for the rest.
//
// A SESSION THAT HAS PLAYED NEVER GIVES UP (2026-10-31). The player only mounts
// while the site's own liveness says stream.place is live, and unmounts when it
// is not, so "is the stream still on?" is never this module's question. Until
// then a viewer whose picture dropped keeps a quiet "Reconnecting…" and a try
// every 30 s, the way Twitch's player does. The old ten-try budget put "Can't
// connect" on screen about five minutes into a phone's dead spot, and the
// viewer had to come back and tap. MAX_RECONNECTS is now two smaller things:
// the budget for a session that has NEVER connected (retryBudgetSpent), and
// the point where the reconnect screen also offers the escapes
// (offerChoicesWhileReconnecting) while it keeps trying.
// @test-only whepEscalation.test.ts and the reconnect render test drive the budget by this count.
export const MAX_RECONNECTS = 10;
const RECONNECT_RAMP_MS = [2000, 4000, 8000, 15000];
const RECONNECT_HOLD_MS = 30000;
export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_RAMP_MS[Math.max(attempt, 1) - 1] ?? RECONNECT_HOLD_MS;
}

/** Stop retrying and hand the viewer the choice? Only for a session that has
 *  never played: a transport that has worked here is retried for as long as
 *  the player is mounted (see the note above MAX_RECONNECTS). */
export function retryBudgetSpent(input: { everConnected: boolean; retryCount: number }): boolean {
  return !input.everConnected && input.retryCount >= MAX_RECONNECTS;
}

/** Has a reconnect run long enough that the screen should also offer the
 *  escapes (Compatibility mode, the embed)? It keeps trying either way. */
export function offerChoicesWhileReconnecting(retryCount: number): boolean {
  return retryCount >= MAX_RECONNECTS;
}

// ── The connect watchdog ─────────────────────────────────────────────────────
// One attempt has three phases before it plays: gathering our own ICE
// candidates ("ice", capped by the player's waitForIce), the WHEP exchange
// through our relay ("signal": the offer is out, no answer yet), and the ICE /
// DTLS checks against the node ("connect": the answer is applied). A
// connection that hangs is judged differently by phase:
//  · "signal" is HTTP. Our relay gives up on the node after
//    WHEP_RELAY_TIMEOUT_MS and answers 502 itself, so the player must not
//    abandon the request sooner — the old 9 s watchdog did, on any attempt whose
//    ICE gathering took more than a second. And a request that never answers
//    is a network that cannot reach THIS SITE right now, not one that blocks
//    WebRTC: it is retried, never answered with "Compatibility mode usually
//    works" (prod 10-30: an Android phone's telemetry rows were all held and
//    then delivered in one burst at 20:11:02 — its HTTP was not getting out).
//  · "connect" is the media path. Hanging here is the UDP-hostile network
//    (GrapheneOS Vanadium's default): retried when this session has played,
//    else the choice panel.

/** The relay's own deadline on the node (whepProxy.ts takes it as its default). */
export const WHEP_RELAY_TIMEOUT_MS = 8000;
/** waitForIce's cap: the offer goes out with whatever was gathered by then. */
export const ICE_GATHER_CAP_MS = 2500;
/** "Connecting…" has this one deadline from the start of an attempt — the HLS
 *  path bounds its start with the same window. */
export const CONNECT_TIMEOUT_MS = 9000;
/** The latest an answer can arrive and still be our relay's answer: gathering's
 *  cap + the relay's own deadline + 2 s for the two hops between the viewer and
 *  the relay. Derived, not tuned: lowering a term moves this with it. */
// @test-only the tests prove the derivation and tick the player to it; watchdogVerdict is its runtime reader.
export const SIGNAL_DEADLINE_MS = ICE_GATHER_CAP_MS + WHEP_RELAY_TIMEOUT_MS + 2000;
/** The ICE/DTLS checks get at least this long after the answer: what they had
 *  under the old single deadline when gathering ran to its cap and the answer
 *  was instant. A late answer no longer leaves them no time at all. */
// @test-only whepEscalation.test.ts asserts the late-answer window; watchdogVerdict is its runtime reader.
export const ICE_CHECK_MS = CONNECT_TIMEOUT_MS - ICE_GATHER_CAP_MS;

export type NegotiationPhase = "ice" | "signal" | "connect" | "media";

// ── A busy relay ─────────────────────────────────────────────────────────────
// A 429 (our relay's per-address limit, or the node's own) is "busy", not a
// transport that fails: the player waits and tries again by itself, counted
// against no budget. Retrying does not deepen our own limit — a refused call
// records nothing (rateLimit.ts) — and the wait keeps one viewer to a few
// tries a minute against a cap of 120.

/** The wait when a 429 names none. The relay sends it on its own 429s too. */
export const BUSY_RETRY_S = 10;
const BUSY_MIN_MS = 2000;   // a "0" must not become a tight loop
const BUSY_MAX_MS = 60_000; // nor a huge value a wait of minutes

/** How long to wait before trying again after a 429: its Retry-After
 *  (delta-seconds or an HTTP date), bounded; BUSY_RETRY_S when absent or junk. */
export function busyRetryMs(retryAfter: string | null, now: number = Date.now()): number {
  const v = (retryAfter ?? "").trim();
  let ms: number;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = v && !/^-?\d/.test(v) ? Date.parse(v) : NaN;
    ms = Number.isFinite(at) ? at - now : BUSY_RETRY_S * 1000;
  }
  return Math.min(BUSY_MAX_MS, Math.max(BUSY_MIN_MS, ms));
}

export type WatchdogVerdict =
  | { kind: "wait"; ms: number }
  | { kind: "reconnect" }
  | { kind: "fallback" }
  | { kind: "none" };

/**
 * The watchdog's judgement of one attempt, `elapsedMs` after it started.
 * `answeredAtMs` is when the answer was applied (meaningful in "connect").
 */
export function watchdogVerdict(input: {
  phase: NegotiationPhase;
  elapsedMs: number;
  answeredAtMs: number | null;
  everConnected: boolean;
}): WatchdogVerdict {
  const { phase, elapsedMs, answeredAtMs, everConnected } = input;
  if (phase === "media") return { kind: "none" };
  if (phase === "ice" || phase === "signal") {
    const left = SIGNAL_DEADLINE_MS - elapsedMs;
    return left > 0 ? { kind: "wait", ms: left } : { kind: "reconnect" };
  }
  const deadline = Math.max(CONNECT_TIMEOUT_MS, (answeredAtMs ?? 0) + ICE_CHECK_MS);
  const left = deadline - elapsedMs;
  if (left > 0) return { kind: "wait", ms: left };
  return everConnected ? { kind: "reconnect" } : { kind: "fallback" };
}

export type EscalationInput = {
  /** RTCPeerConnection.connectionState */
  state: RTCPeerConnectionState;
  /** Has this session ever reached "connected"? */
  everConnected: boolean;
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
  const { state, everConnected, aborted } = input;

  if (aborted) return { kind: "none" };
  if (state === "connected" || state === "new" || state === "connecting") return { kind: "none" };

  // TRANSIENT. The whole point of this module: wait, do not escalate.
  if (state === "disconnected") return { kind: "wait", graceMs: DISCONNECT_GRACE_MS };

  // "closed" without `aborted` means the far side closed it; treat as failed.
  if (state === "failed" || state === "closed") {
    // Never connected => WebRTC does not work on this network (blocked UDP,
    // hostile proxy). Retrying the same transport will not help.
    // Has played here => reconnect, with no budget: see MAX_RECONNECTS.
    return everConnected ? { kind: "reconnect" } : { kind: "fallback" };
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
