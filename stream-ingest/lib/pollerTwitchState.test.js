// twitchStatus's three-valued answer.
//
// A missing client-id, a fetch/timeout error, an HTTP 5xx and a Helix error
// envelope must not read like a successful Helix answer saying "not streaming",
// or a Twitch API blip is indistinguishable from the stream ending and only the
// miss threshold stands between two consecutive blips and a session closing
// under a live stream. `unknown` votes neither way and never advances that
// threshold, so a blip costs nothing.
//
// Run: node --test lib/pollerTwitchState.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

// Set before importing: twitchToken.js seeds its access token from env at module
// load, and poller.js reads BROADCASTER_ID the same way. No refresh token, so
// the 401 path's refreshAccessToken() is a no-op and the retry re-uses this one.
process.env.TWITCH_OAUTH_TOKEN = 'test-access-token';
delete process.env.TWITCH_REFRESH_TOKEN;
process.env.TWITCH_BROADCASTER_ID = '555123456';
// An app pair is set too (made-up values): with a bot token present, the bot token is still what
// Helix is asked with — the stub below fails any request that is not validate or Helix.
process.env.TWITCH_CLIENT_ID = 'test-app-client-id';
process.env.TWITCH_CLIENT_SECRET = 'test-app-client-secret';
delete process.env.TWITCH_OAUTH_CLIENT_ID;
delete process.env.TWITCH_OAUTH_CLIENT_SECRET;

const { twitchStatus } = await import('./poller.js');

const realFetch = global.fetch;
// Answers the client-id validate call for every test (it is not what any of
// these are about) and hands the Helix call to the per-test handler.
function stub(helix) {
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('id.twitch.tv/oauth2/validate')) {
      return { ok: true, status: 200, json: async () => ({ client_id: 'test-client-id' }) };
    }
    assert.match(u, /api\.twitch\.tv\/helix\/streams\?user_id=555123456/);
    return helix(u, init);
  };
}
function restore() { global.fetch = realFetch; }

test('an empty Helix data array is a genuine offline', async () => {
  stub(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  try {
    assert.deepEqual(await twitchStatus(), { state: 'offline', viewers: 0 });
  } finally { restore(); }
});

test('a bot token is preferred over the app pair: its token and its client id ask Helix', async () => {
  let seen = null;
  stub(async (_u, init) => { seen = init.headers; return { ok: true, status: 200, json: async () => ({ data: [] }) }; });
  try {
    assert.deepEqual(await twitchStatus(), { state: 'offline', viewers: 0 });
    assert.equal(seen.Authorization, 'Bearer test-access-token');
    assert.equal(seen['Client-Id'], 'test-client-id', 'the bot token\'s own client id (validate), not the app\'s');
  } finally { restore(); }
});

test('a live stream reports live plus the viewer count', async () => {
  stub(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ viewer_count: 137 }] }) }));
  try {
    assert.deepEqual(await twitchStatus(), { state: 'live', viewers: 137 });
  } finally { restore(); }
});

test('a network error reports unknown, not offline', async () => {
  stub(async () => { throw new Error('ETIMEDOUT'); });
  try {
    assert.equal((await twitchStatus()).state, 'unknown',
      'a failed request must never read the same as Helix answering "not streaming"');
  } finally { restore(); }
});

test('an HTTP 5xx reports unknown, not offline', async () => {
  stub(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  try {
    assert.equal((await twitchStatus()).state, 'unknown');
  } finally { restore(); }
});

test('a 401 that survives the token refresh reports unknown, not offline', async () => {
  // The real shape of an expired/revoked token: Helix 401s, the poller refreshes
  // and retries once, and the retry 401s too. Reading `j.data && j.data[0]` off
  // that error envelope would give undefined and report offline.
  stub(async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' }),
  }));
  try {
    assert.equal((await twitchStatus()).state, 'unknown');
  } finally { restore(); }
});

test('a 200 whose body carries no data array reports unknown, not offline', async () => {
  // Shape drift / an error envelope served with a 200. "I cannot parse this"
  // is not evidence that the stream ended.
  stub(async () => ({ ok: true, status: 200, json: async () => ({ message: 'something else entirely' }) }));
  try {
    assert.equal((await twitchStatus()).state, 'unknown');
  } finally { restore(); }
});
