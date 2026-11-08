// Push hints: a platform's own realtime "started" / "stopped" signal — Kick's StreamerIsLive /
// StopStreamBroadcast channel events, the stream.place record's ended stamp. A hint is not an
// answer (ADR 0134 E7/E11): it only wakes the poller (lib/poller.js) for an immediate read, and that
// read's answer is what counts. Kick's API answering not-live shortly after its stop event is a
// certain end; the event alone never ends anything.
//
// One last hint per platform, in memory: a restart forgets them, so after a restart an end needs
// its usual second reading.

import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';

const KINDS = new Set(['live', 'stop']);
const last = new Map(); // platform → { kind, at }
const listeners = new Set();

/**
 * Record a hint and tell every listener. Throws on a platform or kind outside the vocabulary.
 * @param {string} platform one of PLATFORM_LIVENESS.PLATFORMS
 * @param {'live'|'stop'} kind
 * @param {number} [at] when the platform said so
 */
export function noteHint(platform, kind, at = Date.now()) {
  if (!PLATFORM_LIVENESS.PLATFORMS.includes(platform)) throw new Error(`unknown platform ${platform}`);
  if (!KINDS.has(kind)) throw new Error(`unknown hint kind ${kind}`);
  last.set(platform, { kind, at });
  for (const fn of [...listeners]) {
    try {
      fn({ platform, kind, at });
    } catch (e) {
      console.warn(`[hints] a listener failed on ${platform} ${kind}: ${e.message}`);
    }
  }
}

/**
 * The last hint this platform sent, or null. A copy.
 * @param {string} platform
 * @returns {{ kind: 'live'|'stop', at: number } | null}
 */
export function lastHint(platform) {
  const h = last.get(platform);
  return h ? { ...h } : null;
}

/**
 * Hear every hint from now on. Returns the unsubscribe.
 * @param {(h: { platform: string, kind: 'live'|'stop', at: number }) => void} fn
 * @returns {() => void}
 */
export function onHint(fn) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
