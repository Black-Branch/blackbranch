// One platform's live state, from its previous state and this tick's observation. Pure: no clock,
// no I/O, no log. lib/poller.js runs every platform through it each tick; the vote, the log line and
// (Task 6) the published snapshot all read its result.
//
// The rules (spec: vault briefs/per-platform-liveness-research-2026-10-23.md §D2, ADR 0134 E7):
//   • live counts at once. A scheduled broadcast (upcoming) is never live.
//   • An answered offline the platform stated as certain counts at once; any other answered offline
//     needs OFFLINE_CONFIRMATIONS consecutive answered readings, and until then reads as unknown
//     with the pending evidence. From upcoming (which already votes offline) it counts at once.
//   • unknown (could not ask, or could not read the answer) neither adds to nor resets the count,
//     and is not an answer, so lastAnswerAt stays.
// It names no platform, state or code itself: they all come from the vocabulary.

import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';

const { PLATFORMS, STATES, OFFLINE_CONFIRMATIONS, PENDING_EVIDENCE } = PLATFORM_LIVENESS;

/**
 * @typedef {{ raw: string, certain: boolean, key: string, evidence: string, scheduledStart?: number|null }} Observation
 * @typedef {{ state: string, since: number, lastAnswerAt: number|null, misses: number, key: string,
 *   evidence: string, scheduledStart: number|null }} PlatformState
 */

/**
 * @param {PlatformState|null} prev
 * @param {Observation|null} obs   null = the platform is not configured (no vote)
 * @param {number} now             the tick's time; it stands in for the observation's
 * @returns {PlatformState|null}
 */
export function platformState(prev, obs, now) {
  if (!obs) return null;
  const m = prev ? prev.misses : 0;
  const answered = obs.raw !== STATES.unknown;
  let state;
  let misses;
  let evidence = obs.evidence;
  if (obs.raw === STATES.live || obs.raw === STATES.upcoming) {
    state = obs.raw;
    misses = 0;
  } else if (!answered) {
    state = STATES.unknown;
    misses = m;
  } else {
    misses = m + 1;
    const confirmed = obs.certain || misses >= OFFLINE_CONFIRMATIONS
      || prev?.state === STATES.offline || prev?.state === STATES.upcoming;
    if (confirmed) {
      state = STATES.offline;
    } else {
      state = STATES.unknown;
      evidence = PENDING_EVIDENCE;
    }
  }
  return {
    state,
    since: prev && prev.state === state ? prev.since : now,
    lastAnswerAt: answered ? now : prev ? prev.lastAnswerAt : null,
    misses,
    key: answered || !prev ? obs.key : prev.key,
    evidence,
    scheduledStart: answered || !prev ? obs.scheduledStart ?? null : prev.scheduledStart,
  };
}

/**
 * The platform's vote in the night's decision. A scheduled broadcast votes offline.
 * @param {PlatformState|null} s
 * @returns {string|null}
 */
export function voteOf(s) {
  if (!s) return null;
  return s.state === STATES.upcoming ? STATES.offline : s.state;
}

/** One platform as the states line prints it. */
function shown(s) {
  if (!s) return 'unconfigured';
  if (s.state === STATES.unknown && s.evidence === PENDING_EVIDENCE) return `${STATES.offline}(${s.misses}/${OFFLINE_CONFIRMATIONS})`;
  if (s.state === STATES.unknown) return `${s.state}(${s.evidence})`;
  return s.state;
}

/**
 * The per-tick journal line: every platform, configured or not, in PLATFORMS order. A pending
 * answered offline prints as `offline(1/2)`, so it never reads like "could not ask".
 * @param {Record<string, PlatformState|null>} states
 * @returns {string}
 */
export function formatStatesLine(states) {
  return `[poller] platform states: ${PLATFORMS.map((p) => `${p}=${shown(states[p] ?? null)}`).join(' ')}`;
}

/**
 * One journal line when a platform's state changes, else null. The key is the new state's, or the
 * previous one's when the answer carries none (an answered offline names no broadcast).
 * @param {string} name
 * @param {PlatformState|null} prev
 * @param {PlatformState|null} next
 * @returns {string|null}
 */
export function transitionLine(name, prev, next) {
  const from = prev ? prev.state : 'none';
  const to = next ? next.state : 'none';
  if (from === to) return null;
  if (!next) return `[liveness] ${name} ${from}→${to}`;
  const key = next.key || prev?.key || '';
  return `[liveness] ${name} ${from}→${to} (${next.evidence}${key ? ` on ${key}` : ''})`;
}
