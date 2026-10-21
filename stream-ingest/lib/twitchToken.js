// Twitch token manager with auto-refresh.
//
// The bot account's chat token is minted by twitchtokengenerator.com, so it is bound
// to that site's Twitch app — refresh therefore goes through its API endpoint
// (no Twitch client secret needed here). Twitch user access tokens expire, so
// the vendored chatClient calls the tokenProvider again on every reconnect; the
// first connect is seeded with the .env token and later connects refresh (a
// reconnect almost always means the previous token expired).
//
// This depends on twitchtokengenerator's service staying up. A self-hosted refresh
// using the channel's own Twitch app (client id + secret) would remove that dependency.
//
// SECURITY: the refresh token rides in the URL *path*, not a body. This is forced
// by the provider: POSTing the token in a form/JSON body returns "Refresh token
// required" (the body is ignored); the endpoint only reads it from the path.
// Exposure is limited: the request is HTTPS straight to the token's own issuer (no
// intermediary proxy) and the URL is never logged. The proper fix is the
// self-hosted refresh above — POST https://id.twitch.tv/oauth2/token
// (grant_type=refresh_token in the body, with the channel's own client_id/secret)
// — which removes the third-party dependency AND gets the token out of the path.
// Do NOT "fix" this by switching to a body here: this provider won't read it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payloadShape } from './logShape.js';

const refreshUrl = (rt) =>
  `https://twitchtokengenerator.com/api/refresh/${encodeURIComponent(rt)}`;

// Rotations are persisted here (runtime config/ — deploys --exclude it), so a
// restart resumes the CURRENT refresh token instead of resurrecting the .env
// one that rotation may have revoked hours ago. The file records the .env
// value it superseded: if .env no longer matches (a fresh pair was minted by
// hand), the file describes a dead lineage and .env wins.
const statePath = process.env.TWITCH_TOKEN_STATE_PATH
  || fileURLToPath(new URL('../config/twitch-token.json', import.meta.url));

let accessToken = process.env.TWITCH_OAUTH_TOKEN || null;
let refreshToken = process.env.TWITCH_REFRESH_TOKEN || null;
let seeded = Boolean(accessToken); // use the env token as-is on first connect

try {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state && state.refresh && state.envRefresh === refreshToken) {
    refreshToken = state.refresh;
  }
} catch { /* no persisted rotation yet */ }

function persistRotation(rotated) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      refresh: rotated,
      envRefresh: process.env.TWITCH_REFRESH_TOKEN || null,
      rotatedAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[twitch] could not persist rotated refresh token:', err.message);
  }
}

function identity() {
  return { login: (process.env.TWITCH_BOT_USERNAME || '').toLowerCase() };
}

/** Current access token (shared with the chat client); may be null before seed. */
export function getAccessToken() {
  return accessToken;
}

// Single-flight: the poller's 401 retry and the chat client's reconnect
// tokenProvider both land here at expiry — the exact moment both notice at
// once. The provider ROTATES the refresh token on use, so a second concurrent
// call would spend an already-consumed token. Concurrent callers share one
// request; this is not a cache — sequential calls still each refresh.
let inflightRefresh = null;

export async function refreshAccessToken() {
  if (!refreshToken) return accessToken;
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const res = await fetch(refreshUrl(refreshToken), { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      if (data && data.token) {
        accessToken = data.token;
        if (data.refresh && data.refresh !== refreshToken) {
          refreshToken = data.refresh;
          persistRotation(data.refresh);
        }
        console.log('[twitch] access token refreshed');
      } else {
        // Status and keys only: an error body can carry a token or the account's login.
        console.warn(`[twitch] token refresh returned no token: HTTP ${res.status} ${payloadShape(data)}`);
      }
    } catch (err) {
      console.warn('[twitch] token refresh failed:', err.message);
    }
    return accessToken;
  })().finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

// How long a seed token must still have to be used for the first login as it is.
const SEED_MARGIN_S = 300;

/**
 * Is the seed (.env) access token still good for a login? Twitch's validate endpoint answers its
 * remaining life. A refused token (401) or one about to expire is stale; a network failure cannot
 * tell, and is answered "use it".
 * @returns {Promise<boolean>} true = log in with the seed as it is
 */
export async function seedStillValid(token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const res = await fetchImpl('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return false;
    if (!res.ok) return true;
    const j = await res.json();
    // expires_in 0 = a token that does not expire.
    const left = Number(j?.expires_in);
    return !(left > 0 && left < SEED_MARGIN_S);
  } catch {
    return true;
  }
}

// tokenProvider for createTwitchChatClient. The first call returns the seed token — refreshed
// FIRST when it has already expired (the .env token outlives its few hours; logging in with it
// fails as "stale token" until a reconnect refreshes it). Subsequent calls (reconnects) refresh
// first.
export async function twitchTokenProvider() {
  if (seeded) {
    seeded = false;
    if (refreshToken && accessToken && !(await seedStillValid(accessToken))) {
      console.log('[twitch] the seed access token has expired — refreshing before the first login');
      await refreshAccessToken();
    }
  } else {
    await refreshAccessToken();
  }
  return accessToken ? { token: accessToken, identity: identity() } : null;
}
