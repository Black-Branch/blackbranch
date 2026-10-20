// Memory: chat message embeddings.
//
// New chat messages are embedded through the `embeddings` AI slot and stored by stream-api (the
// one writer of the vector table). The bot embeds a question with embedText() before a search.
// Writers: the platform pipeline (pipeline.js), site messages heard on the internal feed
// (startMemoryFeed below — so memory works with no bot plugin running), and a bot plugin's own
// lines.
//
// Everything is gated on memory.state being 'on' (read per call, so a pause or a resume applies
// at once). The vector length must equal memory.state.dim — the column's, checked by stream-api
// at boot. A condition that will not clear by itself (wrong length, a refused key, no quota, the
// model gone) asks stream-api to PAUSE memory: one alarm, never a silent stop. Network errors,
// 5xx and timeouts keep trying and alarm after five in a row.

import { storeEmbedding, memoryAllowed, pauseMemory } from './api.js';
import { makeRunAlarm } from './ops.js';
import { instanceConfig } from './instanceConfig.js';
import { ai } from './ai.js';
import { NATIVE_PLATFORM, isNativePlatform } from './native-platform.js';

const failingAlarm = makeRunAlarm({ key: 'memory.failing', title: 'Memory embeddings failing', after: 5 });
// The pause itself alarms in stream-api. This one fires only when stream-api could not be told.
const pauseUnreportedAlarm = makeRunAlarm({ key: 'memory.pause-unreported', title: 'Memory should pause — stream-api unreachable', after: 1 });

const PAUSE_FOR = { key_rejected: 'key_rejected', key_missing: 'key_rejected', quota: 'quota', model_not_found: 'model_not_found' };
const PAUSE_ASK_EVERY_MS = 30_000;
const lastPauseAsk = new Map();   // reason → ms: one ask per reason per 30 s until the pause lands

function memoryState() {
  const s = instanceConfig.get('memory.state');
  return s && instanceConfig.get('memory.enabled') === true && s.status === 'on' ? s : null;
}

async function askPause(reason) {
  const now = Date.now();
  if (now - (lastPauseAsk.get(reason) || 0) < PAUSE_ASK_EVERY_MS) return;
  lastPauseAsk.set(reason, now);
  console.error(`[memory] asking stream-api to pause memory: ${reason}`);
  try {
    await pauseMemory(reason);
    pauseUnreportedAlarm.ok();
  } catch (e) {
    // The reason and the error class only — never a message's text.
    pauseUnreportedAlarm.fail(`${reason}; ${e.status ? `HTTP ${e.status}` : 'unreachable'}`);
  }
}

/**
 * Embed a string (a message, or a search question).
 * @param {string} text
 * @param {{ signal?: AbortSignal }} [opts]  the caller's budget signal, so a slow embed aborts
 *   with the pass it belongs to.
 * @returns {Promise<number[]|null>} a memory.state.dim-length vector, or null when memory is off,
 *   paused, or the vector is unusable. Rejects on a provider failure, as before.
 */
export async function embedText(text, opts = {}) {
  const input = (text || '').trim();
  if (!input) return null;
  const state = memoryState();
  if (!state) return null;
  const route = ai.route('embeddings');
  if (!route.enabled) return null;
  let out;
  try {
    out = await ai.embed([input], { signal: opts.signal, route, dimensions: state.reduced ? state.dim : undefined });
  } catch (e) {
    const code = e && e.code;
    if (PAUSE_FOR[code]) await askPause(PAUSE_FOR[code]);
    else if (code !== 'aborted') failingAlarm.fail(code || 'error');
    throw e;
  }
  failingAlarm.ok();
  const vec = out.vectors[0];
  if (vec.length !== state.dim) {
    console.warn(`[memory] embedder returned ${vec.length} dimensions, memory is ${state.dim}`);
    await askPause('dim_mismatch');
    return null;
  }
  return vec;
}

/**
 * Embed a chat message and store it. Called after the message is persisted, so it has its id.
 * Non-fatal for the caller (it catches).
 * @param {object} args
 * @param {'platform'|'native'|string} args.source  a person's message, or a bot plugin's own line
 * @param {number} args.sourceId  chat_log.id, site.chat_messages.id, or the plugin's row id
 * @param {string} args.username
 * @param {string} args.message   emote-stripped message text
 * @param {string|null} [args.targetName]  who a bot line was said to
 */
export async function embedMessage({ source, sourceId, username, message, targetName = null }) {
  if (sourceId == null || !message) return;
  const state = memoryState();
  if (!state) return;
  // A person who switched AI memory off is never embedded — not even sent to the embedder.
  // Fail closed: if stream-api cannot answer, this message is simply not remembered.
  const { allowed } = await memoryAllowed({ source, source_id: sourceId, target_name: targetName });
  if (allowed !== true) return;
  const vec = await embedText(message);
  if (!vec) return;
  try {
    await storeEmbedding({ source, source_id: sourceId, username, target_name: targetName, message, embedding: vec, model: state.model });
  } catch (e) {
    // 409 = memory paused or off since the check above; a 400 dim_mismatch has already paused
    // memory on stream-api's side. Anything else is the caller's to log.
    if (e.status === 409 || (e.status === 400 && e.body && e.body.error === 'dim_mismatch')) return;
    throw e;
  }
}

const words = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;

/** Should this live-feed frame be remembered as a site message? Pure. */
export function nativeFrameToRemember(f, botMatrixId, minWords) {
  if (!f || f.type !== 'message' || f.deleted || !isNativePlatform(f.platform)) return false;
  if (f.system) return false;                       // a tip / sub / event card, not a chat line
  if (f.id == null || !f.username || !f.message) return false;
  if (botMatrixId && f.matrixId === botMatrixId) return false;
  return words(f.message) >= minWords;
}

/** Remember site messages as they are broadcast, on the settings layer's internal socket. */
export function startMemoryFeed(cfg = instanceConfig) {
  const off = cfg.onMessage((text) => {
    if (!text.includes('"message"') || !text.includes(`"${NATIVE_PLATFORM}"`)) return;
    let f;
    try { f = JSON.parse(text); } catch { return; }
    if (!memoryState()) return;
    if (!nativeFrameToRemember(f, cfg.get('bot.matrixId'), cfg.get('memory.minWords'))) return;
    embedMessage({ source: 'native', sourceId: f.id, username: f.username, message: f.message })
      .catch((err) => console.warn(`[memory] embed failed id=${f.id}: ${err.message}`));
  });
  return { stop: off };
}
