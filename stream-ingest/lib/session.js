// Tracks the current stream session id by polling stream-api's public
// GET /stream/current. Session creation lives in lib/poller.js, which posts
// /stream/start and /stream/end; this module only reads the active streamId
// to tag /chat rows.
// When offline (live:false) chat is still ingested, with streamId = null.

import { getCurrentStream } from './api.js';

const POLL_MS = 30000;

let currentStreamId = null;
let timer = null;

async function poll() {
  try {
    const s = await getCurrentStream();
    currentStreamId = s && s.live ? (s.streamId ?? null) : null;
  } catch (err) {
    // Keep last known value on transient error.
    console.warn('[session] poll failed:', err.message);
  }
}

export async function startSessionPolling() {
  await poll();
  timer = setInterval(poll, POLL_MS);
  if (timer.unref) timer.unref();
}

export function stopSessionPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** @returns {string|null} active streamId, or null when offline */
export function getStreamId() {
  return currentStreamId;
}
