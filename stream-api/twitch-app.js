// Twitch app-token owner + Helix user lookups.
//
// Twitch profile pictures for the alert path and the chat path resolve here, so
// no third party's host sits on the money/alert path or the chat hot path.
//
// The lookups live HERE rather than in stream-ingest because this is where the
// alert and chat paths that need them run, and account-age.js already mints an
// app token with the same credentials.
//
// In this process the app token cache lives here and NOWHERE else (account-age.js
// uses it); two caches would mint two tokens and each would have to learn about
// 401s independently. stream-ingest's poller mints its own from the same app pair
// for live status when no bot account is signed in (its lib/poller.js): a
// separate process, and an app may hold several app tokens at once.

'use strict';
const { instanceConfig } = require('./instance-config');

// ── app token ───────────────────────────────────────────────────────────────
// client_credentials, ~60 days. Refreshed a minute before expiry.

let appToken = null; // { token, expiresAt }

function clientId() {
  // Instance key twitch.clientId — env TWITCH_OAUTH_CLIENT_ID, then the alias TWITCH_CLIENT_ID
  // (the order this line always had), then the stored credential.
  return instanceConfig.get('twitch.clientId') || '';
}

/**
 * @returns {Promise<string|null>} null when no credentials are configured —
 *   the caller decides whether that is "unknown" or "skip".
 * @throws on an HTTP/shape failure, so a credential problem is never silently
 *   turned into "this account is unverifiable".
 */
async function getAppToken() {
  const id = clientId();
  const secret = instanceConfig.get('twitch.clientSecret');
  if (!id || !secret) return null;
  if (appToken && Date.now() < appToken.expiresAt - 60_000) return appToken.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`twitch token HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('twitch token response missing access_token');
  appToken = { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return appToken.token;
}

/** Drop the cached token so the next call re-mints. Call on a 401 from Helix. */
function invalidateAppToken() {
  appToken = null;
}

/**
 * GET /helix/users?id=… — the raw response row for one user id.
 *
 * Status handling is the caller's business, because the same code means
 * different things to different callers (account-age treats 400 as "this
 * identifier is unverifiable"; the avatar resolver treats everything as
 * "no picture"). This only invalidates the token on 401 and rethrows.
 *
 * @returns {Promise<object|null>} the user row, or null if Twitch returned no row
 */
async function helixUserById(platformId) {
  const id = clientId();
  const token = await getAppToken();
  if (!token) return null;
  const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(platformId)}`, {
    headers: { 'Client-Id': id, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) { invalidateAppToken(); throw new Error('twitch 401 (app token rejected)'); }
  if (res.status === 400) { const e = new Error('twitch 400 (bad identifier)'); e.badIdentifier = true; throw e; }
  if (!res.ok) throw new Error(`twitch users HTTP ${res.status}`);
  const j = await res.json();
  return j?.data?.[0] ?? null;
}

// ── profile image resolver ──────────────────────────────────────────────────
//
// Called on the chat hot path, so it MUST be cheap and MUST NOT throw. A busy
// chat is many messages from few people, so a per-user cache collapses a whole
// stream to one lookup per chatter. Helix allows 800 requests/min on an app
// token; without the cache a 200-message minute would approach that for no gain.

const POSITIVE_TTL_MS = 12 * 60 * 60 * 1000; // profile pictures change rarely
const NEGATIVE_TTL_MS = 10 * 60 * 1000;      // ...but don't retry a failure per message
const MAX_ENTRIES = 5000;                    // bounded: a raid must not grow this forever

const pics = new Map(); // platformId -> { url, expiresAt }

/**
 * Twitch profile image for a numeric user id.
 *
 * **Never throws and never returns null** — the empty string is the "no picture"
 * value every consumer already handles (`p.userImage || ''`, and the web falls
 * back to a deterministic coloured initial). An alert or a chat line must never
 * fail because a picture lookup did.
 *
 * @param {string|number} platformId Twitch numeric user id
 * @returns {Promise<string>} an https URL, or '' when unknown
 */
async function twitchProfileImage(platformId) {
  const key = String(platformId || '');
  if (!key) return '';

  const hit = pics.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.url;

  let url = '';
  try {
    const row = await helixUserById(key);
    url = typeof row?.profile_image_url === 'string' ? row.profile_image_url : '';
  } catch (err) {
    // Deliberately quiet at warn level: this runs per new chatter, and a Twitch
    // outage should not fill the journal. The negative TTL bounds the retries.
    if (!err.badIdentifier) console.warn('[twitch] profile image lookup failed:', err.message);
    url = '';
  }

  // Evict oldest-inserted first (Map preserves insertion order). Not a true LRU;
  // the point is a hard bound, and every entry expires anyway.
  if (pics.size >= MAX_ENTRIES) {
    const oldest = pics.keys().next().value;
    if (oldest !== undefined) pics.delete(oldest);
  }
  pics.set(key, { url, expiresAt: Date.now() + (url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return url;
}

/** Test seam: drop both caches. */
function __resetTwitchAppCaches() {
  appToken = null;
  pics.clear();
}

module.exports = {
  getAppToken,
  invalidateAppToken,
  twitchProfileImage,
  __resetTwitchAppCaches,
};
