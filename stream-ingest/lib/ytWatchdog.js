// YouTube api-poller liveness decision — extracted as a pure function so it is
// testable without a live stream (`platforms/youtube.js` is one big closure).
//
// The question is "has this page delivered chat recently?", not "is a poller
// registered?". A live page in api mode that hasn't produced a successful poll
// within the threshold is stalled — whether the poller is wedged, died, or never
// started. Gating on `apiPollerFor === page` would leave two dead zones:
//
//   (a) BOOTSTRAP FAILURE. startApiPoller() returns early when ytcfg/continuation
//       are missing, BEFORE it ever sets apiPollerFor. The page then lives on the
//       ~8s passive net read, and a registration gate would never rebuild it.
//   (b) DEAD POLLER, LIVE PAGE. The loop's finally nulls apiPollerFor when it
//       exits. A poller that dies while its page stays open would fail the gate
//       and have its stall counter reset every tick — never rebuilt either.
//
// `pollerRegistered` is only diagnostic colour in the log line.
//
// Timing: with the defaults below, a stall needs 3 consecutive 30s ticks past a
// 45s threshold, i.e. ~105-135s of dead chat before a rebuild. The debounce is
// deliberate — a rebuild resets the dedupe set and drops the next response as
// backlog — so a cheaper in-place token re-bootstrap would recover faster.

export const STALL_MS = 45_000;
export const STALL_TICKS = 3;

/**
 * Decide what the supervision tick should do about poller liveness.
 *
 * Pure: no clock, no I/O. The caller passes elapsed time so tests don't need to
 * fake timers.
 *
 * @param {object}  o
 * @param {string}  o.readMode          'api' | 'net' | 'dom' — only 'api' is watched.
 * @param {string}  o.videoId           Currently-resolved live video id ('' when the lookup failed).
 * @param {boolean} o.hasPage           A chat page object exists.
 * @param {boolean} o.pollerRegistered  apiPollerFor === page (diagnostic only).
 * @param {number}  o.msSinceHealthy    ms since this page last did something healthy — the
 *                                      caller computes `now - max(lastPollOkAt, pageOpenedAt)`.
 *                                      Including pageOpenedAt is load-bearing: without it a
 *                                      page whose bootstrap failed inherits the PREVIOUS
 *                                      poller's lastPollOkAt (or 0), which would either
 *                                      suppress the stall or fire it instantly on a fresh page.
 * @param {number}  o.stallCount        Consecutive stalled ticks so far.
 * @param {number} [o.stallMs]
 * @param {number} [o.stallTicks]
 * @returns {{action: 'idle'|'count'|'rebuild', stallCount: number, reason: string|null}}
 */
export function decideWatchdog({
  readMode,
  videoId,
  hasPage,
  pollerRegistered,
  msSinceHealthy,
  stallCount,
  stallMs = STALL_MS,
  stallTicks = STALL_TICKS,
}) {
  // Only the api read path has a liveness signal. 'net' and 'dom' are passive —
  // they have no equivalent of lastPollOkAt, so there is nothing to judge.
  if (readMode !== 'api') return { action: 'idle', stallCount: 0, reason: null };

  // No live video, or no page to rebuild: not a stall, and the counter must
  // reset so an unrelated gap doesn't accumulate toward a spurious rebuild.
  if (!videoId || !hasPage) return { action: 'idle', stallCount: 0, reason: null };

  if (msSinceHealthy <= stallMs) return { action: 'idle', stallCount: 0, reason: null };

  // `pollerRegistered` gates nothing — it only names WHICH failure
  // this is, so the journal line says something useful.
  const reason = pollerRegistered ? 'stale-polls' : 'no-poller';
  const next = stallCount + 1;

  if (next >= stallTicks) return { action: 'rebuild', stallCount: 0, reason };
  return { action: 'count', stallCount: next, reason };
}
