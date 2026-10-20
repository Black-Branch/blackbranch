// YouTube "stream ended" decision — extracted pure, like ytWatchdog.js, so it
// can be exercised without a live stream.
//
// The live LOOKUP (sticky re-verify + /live scrape) can degrade for long
// stretches — "cannot verify (no player response)", /live resolving to foreign
// videos — while the chat API poller on the SAME stream stays healthy. Counting
// those lookup failures as "stream ended" closes the chat mid-stream and leaves
// blind gaps. As in the poller's twitchStatus, a failed LOOKUP is "unknown",
// not "offline".
//
// The strongest liveness evidence available is the chat continuation itself:
// `lastPollOkAt` advances only when a poll returns a real
// liveChatContinuation, and stops advancing promptly once the stream truly
// ends. So: while the chat has delivered within HOLD_MS, a failed lookup does
// not count toward the miss threshold at all. When the stream really ends,
// the continuation goes quiet, the hold expires, and the 3-miss debounce
// applies (starting up to HOLD_MS later — a slower close is cheap; a false
// close costs a blind gap and a cold re-scrape through the same degraded pages
// that caused it).
//
// In non-api read modes `msSinceChatOk` is effectively infinite (lastPollOkAt
// stays 0), so the hold never applies.

export const END_HOLD_MS = 90_000;
export const END_MISS_THRESHOLD = 3;

/**
 * Decide what a failed live-lookup means for the watched stream.
 *
 * Pure: the caller passes elapsed time, no clock here.
 *
 * @param {object} o
 * @param {number}  o.missCount      Consecutive counted lookup misses so far.
 * @param {number}  o.msSinceChatOk  now - lastPollOkAt (Infinity/huge when the
 *                                   api poller has never delivered).
 * @param {number} [o.holdMs]
 * @param {number} [o.missThreshold]
 * @returns {{action: 'hold'|'count'|'close', missCount: number}}
 */
export function decideEnd({ missCount, msSinceChatOk, holdMs = END_HOLD_MS, missThreshold = END_MISS_THRESHOLD }) {
  if (msSinceChatOk < holdMs) return { action: 'hold', missCount: 0 };
  const next = missCount + 1;
  if (next < missThreshold) return { action: 'count', missCount: next };
  return { action: 'close', missCount: 0 };
}
