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

/**
 * @typedef {{ state: 'live'|'offline'|'unknown'|'upcoming', videoId: string, certain?: boolean,
 *   evidence?: string, scheduledStart?: number|null }} Lookup  youtubeLiveState's answer (or the
 *   Data API's, platforms/youtube.js confirmViaApi, when it overruled the page)
 * @typedef {{ raw: string, certain: boolean, key: string, evidence: string, scheduledStart: number|null }} Observation
 *   lib/platformState.js's input
 */

// The waiting room (ADR 0133's split, 0134 E4): our own scheduled broadcast's countdown chat is
// read from this long before its start — lines reach the site and its bot — and never votes live.
// The research's recommendation until the owner names a number; a 24-hours-ahead schedule must not hold a
// headless chat page open all day.
export const YT_WAITING_ROOM_MS = 60 * 60_000;

// The countdown chat is read every COUNTDOWN_POLL_MS, not at the 1 s self-poll the live chat gets
// and not at YouTube's own `timeoutMs` either: at that (~14.5 s on 2026-10-25) a countdown line
// reached the site up to 15 s late. A read is one InnerTube get_live_chat from the open page — no
// Data API unit. Well inside lib/ytWatchdog.js's STALL_MS (45 s), so a countdown page is never
// rebuilt as stalled.
export const COUNTDOWN_POLL_MS = 3000;

/**
 * Which chat page the reader should have, from this tick's lookup. Pure.
 *
 *   live X                                    → open X (keep, when X's page is already open)
 *   our own upcoming X, start − now ≤ window  → open X (keep, when already open): the countdown
 *   upcoming X, further out or no start time  → none (keep a page that is open)
 *   a relay's upcoming X                      → none: other channels' countdowns are never read
 *   offline or unknown                        → keep an open page (decideEnd alone closes it), else none
 *
 * @param {{ lookup: Lookup, chatVideoId: string|null, relay: boolean, now: number, readAheadMs?: number }} o
 * @returns {{ action: 'open'|'keep'|'none', videoId?: string }}
 */
export function chatPlan({ lookup, chatVideoId, relay, now, readAheadMs = YT_WAITING_ROOM_MS }) {
  const id = lookup.videoId || '';
  const keepOr = (other) => (chatVideoId ? { action: 'keep' } : other);
  if (lookup.state === 'live' && id) return id === chatVideoId ? { action: 'keep' } : { action: 'open', videoId: id };
  if (lookup.state === 'upcoming' && id) {
    if (id === chatVideoId) return { action: 'keep' };
    const start = lookup.scheduledStart;
    const soon = !relay && typeof start === 'number' && Number.isFinite(start) && start - now <= readAheadMs;
    return soon ? { action: 'open', videoId: id } : keepOr({ action: 'none' });
  }
  return keepOr({ action: 'none' });
}

/**
 * One reader tick's chat-page decision from the live lookup (platforms/youtube.js runs it).
 *
 * chatPlan picks the page. An open page whose lookup is not `live` or `upcoming` — YouTube answered
 * `offline`, or could not be asked (`unknown`) — is left to decideEnd alike: YouTube keeps serving
 * the chat for ~5 minutes after a broadcast ends, and that tail is read so goodbyes are heard (ADR
 * 0133). A countdown page is not an end in waiting: it is watched, never counted. Whether the
 * stream counts as LIVE meanwhile is watcherVote's question, not this one's.
 *
 * @param {object} o
 * @param {Lookup} o.lookup
 * @param {string|null} o.currentId     the video whose chat page is open, or null
 * @param {number}      o.missCount
 * @param {number}      o.msSinceChatOk
 * @param {boolean}    [o.relay]        a relay (another channel's chat): no countdown is read
 * @param {number}     [o.now]          the tick's time (ms epoch), for the countdown window
 * @returns {{ action: 'open'|'watch'|'hold'|'count'|'close', missCount: number, videoId?: string }}
 *   open = open the chat of `videoId`; watch = keep watching (the stall watchdog runs);
 *   hold / count / close = decideEnd's answer for the open page.
 */
export function decideWatch({ lookup, currentId, missCount, msSinceChatOk, relay = false, now = 0 }) {
  const plan = chatPlan({ lookup, chatVideoId: currentId, relay, now });
  if (plan.action === 'open') return { action: 'open', videoId: plan.videoId, missCount: 0 };
  if (lookup.state === 'live' || lookup.state === 'upcoming') return { action: 'watch', missCount: 0 };
  if (currentId) return decideEnd({ missCount, msSinceChatOk });
  return { action: 'watch', missCount };
}

/**
 * The reader's liveness observation (ADR 0133; Task 4: the state model's input). The chat page being
 * open — `holding`: a page opened on a broadcast that was live, not yet closed by decideEnd — is not
 * evidence of live: YouTube serves the chat after the end. Only a lookup that could not ask
 * (`unknown`) is held as live while that page is open — the degraded-lookup hold above, kept. A
 * countdown page never holds: a scheduled broadcast is never live. Pure.
 *
 *   live                → live, not certain
 *   offline             → offline, certain as the lookup says (the known video's own not-live, or
 *                         the Data API's none / actualEndTime)
 *   upcoming            → upcoming, its start carried
 *   unknown, holding    → live (held-by-chat)
 *   unknown             → unknown
 * The key is the lookup's video id.
 *
 * @param {{ lookup: Lookup, holding: boolean }} o
 * @returns {Observation}
 */
export function watcherVote({ lookup, holding }) {
  const key = lookup.videoId || '';
  const evidence = lookup.evidence || '';
  /** @param {string} raw @param {boolean} certain @param {string} code @returns {Observation} */
  const obs = (raw, certain, code) => ({ raw, certain, key, evidence: code, scheduledStart: raw === 'upcoming' ? lookup.scheduledStart ?? null : null });
  if (lookup.state === 'live') return obs('live', false, evidence);
  if (lookup.state === 'offline') return obs('offline', lookup.certain === true, evidence);
  if (lookup.state === 'upcoming') return obs('upcoming', false, 'upcoming');
  return holding ? obs('live', false, 'held-by-chat') : obs('unknown', false, evidence);
}

/**
 * How long the api read path waits before its next get_live_chat: the 1 s self-poll once the
 * broadcast has been live (the tail included), COUNTDOWN_POLL_MS during a countdown — never faster
 * than the self-poll. Pure.
 * @param {{ live: boolean, selfPollMs: number }} o
 * @returns {number}
 */
export function chatPollDelay({ live, selfPollMs }) {
  return live ? selfPollMs : Math.max(selfPollMs, COUNTDOWN_POLL_MS);
}
