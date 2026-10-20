// Policy for the stream.place liveness probe: when a failed probe actually means
// "the broadcaster's output is down" versus "this viewer could not reach it".
//
// WHY THIS EXISTS. The probe GETs stream.place's playlist and counts consecutive
// failures; N in a row switches the viewer to YouTube. But `catch { ok = false }`
// cannot tell those two situations apart:
//   • stream.place's RTMP output really dropped        → switching is correct
//   • the VIEWER's connection blipped, or their tab was backgrounded and the
//     fetch timed out under throttling                 → switching is WRONG, and
//     it moves someone off a source that was working fine
// Live report: the cascade "was too aggressive and kicked people off a working
// beta player". This is the same failure mode as the WHEP `disconnected` bug in
// whepEscalation.ts — treating a local, transient condition as a remote, terminal
// one — one rung further up the ladder.
//
// The rule: only a failure we can attribute to the REMOTE side counts. If we know
// we were offline or hidden, the probe result is uninformative and is discarded
// rather than counted. Discarding is safe in a way over-counting is not: a
// genuinely dead output keeps failing, so the switch still happens, just a beat
// later. A false switch has no recovery path — `fired` is terminal.

export type ProbeOutcome =
  /** Got an HTTP response. `ok` is the 2xx-ness of it. */
  | { kind: "http"; ok: boolean }
  /** Network error, timeout or abort — no response at all. */
  | { kind: "error" };

export interface ProbeContext {
  /** navigator.onLine at the time of the probe. */
  online: boolean;
  /** True when document.visibilityState === "hidden" (timers throttled). */
  hidden: boolean;
}

export type ProbeVerdict =
  /** Remote is up — reset the failure count. */
  | "up"
  /** Attributable remote failure — count it. */
  | "down"
  /** Uninformative (we were offline/hidden) — do not count either way. */
  | "ignore";

/**
 * Classify one probe result. Pure.
 *
 * A non-2xx HTTP RESPONSE is trusted even while hidden: we reached the server and
 * it told us something. Only the no-response cases are ambiguous enough to
 * discard, because those are exactly what a local network blip produces.
 */
export function classifyProbe(outcome: ProbeOutcome, ctx: ProbeContext): ProbeVerdict {
  if (outcome.kind === "http") return outcome.ok ? "up" : "down";

  // No response. If we know the fault could be ours, refuse to blame the remote.
  if (!ctx.online || ctx.hidden) return "ignore";
  return "down";
}

/**
 * Fold a verdict into the consecutive-failure count.
 * Returns the new count and whether the caller should declare the source down.
 */
export function applyVerdict(
  verdict: ProbeVerdict,
  fails: number,
  threshold: number
): { fails: number; declareDown: boolean } {
  if (verdict === "up") return { fails: 0, declareDown: false };
  if (verdict === "ignore") return { fails, declareDown: false };
  const next = fails + 1;
  return { fails: next, declareDown: next >= threshold };
}
