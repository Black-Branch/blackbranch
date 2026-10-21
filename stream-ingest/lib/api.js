// Thin client for stream-api (the Node->Postgres gateway on port 3001).
// Sends the Bearer secret because a remote host is not in stream-api's
// INTERNAL_IPS allowlist. Uses native fetch (Node >= 18).

import { streamApiBase } from './streamApiUrl.js';

const SECRET = process.env.STREAM_API_SECRET || '';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (SECRET) h.Authorization = `Bearer ${SECRET}`;
  return h;
}

/**
 * One authenticated request to stream-api; rejects on any non-2xx with `status` and the parsed
 * `body` on the error. Every call in this file goes through it.
 * @parked plugin API: the site plugin's own stream-api calls (owner/api.js — the bot's /bot/*
 * surface and the sentiment scores) are built on this, so a plugin sends the same secret, timeout
 * and error shape as the product. Nothing in the product calls it by name.
 */
export async function req(method, path, body, { timeoutMs = 8000 } = {}) {
  const res = await fetch(`${streamApiBase()}${path}`, {
    method,
    headers: headers(),
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`stream-api ${method} ${path} -> ${res.status} ${text}`);
    err.status = res.status;
    try { err.body = JSON.parse(text); } catch { err.body = null; }
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/**
 * Log a chat message.
 * `emotes` ({name:url}) and `replyTo*` are the NEW optional fields added to
 * stream-api's /chat so the two-POST emote/reply-cache dance isn't needed.
 * @returns {Promise<{id:number, canonicalId:string, karma:number, activity:number, streams:number, support:number}>}
 */
export function postChat(payload) {
  return req('POST', '/chat', payload);
}

/**
 * May this message be embedded at all? stream-api answers from the AI-memory opt-out
 * (memory.js). Asked BEFORE the text is sent out to the embedder.
 * @param {{ source: string, source_id: number, target_name?: string|null }} row
 * @returns {Promise<{ allowed: boolean }>}
 */
export function memoryAllowed(row) {
  return req('POST', '/memory/allowed', row, { timeoutMs: 4000 });
}

/** Ask stream-api to pause memory (it writes memory.state and raises the one alarm). */
export function pauseMemory(reason) {
  return req('POST', '/memory/pause', { reason }, { timeoutMs: 4000 });
}

/**
 * Store a message embedding for the bot's semantic search.
 * @param {object} payload { source, source_id, username, message, embedding, model }
 */
export function storeEmbedding(payload) {
  return req('POST', '/embedding', payload);
}

/** Set declared pronouns on a person's canonical identity (the !he/!she/!they cmd). */
/** A pronoun command → stream-api's one parser: { matched:false } | { matched, usage } | { matched, pronouns }. */
export function pronounCommand({ text, canonicalId, platform, userId }) {
  return req('POST', '/identity/pronoun-command', { text, canonicalId, platform, userId });
}

/**
 * Post a native site chat message (the bot's reply on the website).
 * Persists to site.chat_messages + broadcasts. matrixId is the bot's account.
 */
export function postChatNative(payload) {
  return req('POST', '/chat/native', payload);
}

/** Look up a user profile for !karma/!rank: {platform} plus one of {canonicalId}, {userId} or {username} —
 *  with a platform, stream-api answers that one platform identity (profiles.js). */
export function lookupUser(params) {
  const qs = new URLSearchParams(params).toString();
  return req('GET', `/user/lookup?${qs}`);
}

/** @returns {Promise<{live:boolean, streamId:string|null}>} */
export function getCurrentStream() {
  return req('GET', '/stream/current');
}

// ── Viewer poller + stream lifecycle ─────────────────────────────────────────
/** Open a session. body: { streamId } */
export function postStreamStart(streamId) {
  return req('POST', '/stream/start', { streamId });
}
/** Close a session. body: { streamId } */
export function postStreamEnd(streamId) {
  return req('POST', '/stream/end', { streamId });
}
/** Record a viewer heartbeat. body: { streamId, twitch, youtube, kick, streamplace } */
export function postViewerSnapshot(payload) {
  return req('POST', '/viewer-snapshot', payload);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fire a normalized monetization alert. See stream-api POST /alert contract.
 *
 * MONEY PATH — retried, unlike every other call in this file. With one attempt
 * a paid event landing during a stream-api restart, or one ECONNRESET, would be
 * gone forever: no support_events row, no bar credit, no on-stream alert. Retrying is legal ONLY because /alert
 * dedups on `payload.eventId` (minted once by the normalizers, resent
 * verbatim here) — never call this with a payload rebuilt per attempt.
 * 4xx never retries: a rejected envelope does not get better, and each
 * re-POST re-fires the producer-broken notify. */
export async function postAlert(payload, { retryDelays = [1000, 3000] } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (attempt > 0) await sleep(retryDelays[attempt - 1]);
    try {
      return await req('POST', '/alert', payload);
    } catch (e) {
      if (/-> 4\d\d/.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Mirror a platform-side moderation event into the site (flags the matching
 * stream.chat_log rows + broadcasts the same delete/purge frames site mod
 * actions use). Home connections only — relays never call this.
 * @param {{platform:string, platformMsgId?:string, platformUserId?:string, username?:string}} payload
 *   platformMsgId → single message delete; platformUserId/username → user
 *   ban/timeout (clears their recent messages on that platform, purge-style).
 */
export function postPlatformDelete(payload) {
  return req('POST', '/chat/platform-delete', payload);
}

// ── Support relay ──────────────────────────────────────────────────────────
// The site support panel's free-text turns. `getSupportNext` LONG-POLLS —
// stream-api parks it up to ~25 s — so it cannot ride req()'s 8 s abort; it
// gets its own generous timeout instead.
export async function getSupportNext() {
  const res = await fetch(`${streamApiBase()}/bot/support/next`, {
    method: 'GET',
    headers: headers(),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`stream-api GET /bot/support/next -> ${res.status}`);
  return res.json();
}

/** Answer a held support request. `{requestId, text}`; 404 = the ask already timed out. */
export function postSupportReply(payload) {
  return req('POST', '/bot/support/reply', payload);
}

/** Would this text pass the word filter and link gate a person's message meets? `{ ok, reason? }`. */
export function screenText(text) {
  return req('POST', '/chat/screen', { text });
}

/** The chat bot's recall: the nearest remembered people's lines (stream-api memory.js). */
export function searchMemory(body) {
  return req('POST', '/memory/search', body);
}

/** A relayed platform message automod judged risky → a flagged review row (stream-api automod.js). */
export function flagAutomod(body) {
  return req('POST', '/automod/ai', body);
}
