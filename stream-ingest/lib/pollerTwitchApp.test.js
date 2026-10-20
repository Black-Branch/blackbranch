// Twitch live status from the setup wizard's Twitch app alone (external review, finding B).
//
// The wizard says a Twitch app (client id + secret) and the broadcaster id give live status, and
// that signing in a bot account comes later. twitchStatus() used to return "not configured" at
// once without the legacy bot access token, making no request, so a Twitch-only install that
// followed the wizard never got a session. Here there is NO bot token: the settings arrive the
// way a wizard-configured install has them — read from (a fake) stream-api, whose
// /config/secrets hands this process only the credentials the schema lists it as a consumer of.
// The poller then mints its own client-credentials app token and asks Helix.
//
// Run: node --test lib/pollerTwitchApp.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET', 'TWITCH_CHANNEL',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { twitchStatus, startPoller } = await import('./poller.js');
const { instanceConfig } = await import('./instanceConfig.js');
const { INSTANCE_KEYS, instanceEntry } = await import('./instanceSchema.generated.js');

const APP_ID = 'casey-app-client-id';
const APP_SECRET = 'casey-app-client-secret';
const BROADCASTER = '424242';

// What the setup wizard stores: the channel and broadcaster id as plain settings, the app pair
// as credentials.
const STORED_PLAIN = { 'platform.twitch.channel': 'casey', 'platform.twitch.broadcasterId': BROADCASTER };
const STORED_SECRETS = { 'twitch.clientId': APP_ID, 'twitch.clientSecret': APP_SECRET };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = global.fetch;

/** A world: a fake stream-api (settings + lifecycle), a fake Twitch token endpoint and Helix. */
function world({ helix, token }) {
  const w = { tokenCalls: 0, helixCalls: [], unexpected: [], api: { live: false, streamId: null, starts: [], snapshots: [] } };
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === '/config') return json({ values: STORED_PLAIN });
      if (path === '/config/secrets?package=stream-ingest') {
        // stream-api's rule: a package gets the credentials the schema lists it as reading.
        const values = Object.fromEntries(Object.entries(STORED_SECRETS)
          .filter(([k]) => INSTANCE_KEYS.find((e) => e.key === k)?.packages.includes('stream-ingest')));
        return json({ values, unreadable: [] });
      }
      if (path === '/content') return json({ content: {} });
      if (method === 'GET' && path === '/stream/current') return json({ live: w.api.live, streamId: w.api.streamId });
      if (method === 'POST' && path === '/stream/start') { w.api.live = true; w.api.streamId = body.streamId; w.api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { w.api.snapshots.push(body); return json({ ok: true }); }
    }
    if (u === 'https://id.twitch.tv/oauth2/token') {
      w.tokenCalls += 1;
      const form = new URLSearchParams(String(init.body));
      assert.equal(method, 'POST');
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('client_id'), APP_ID);
      assert.equal(form.get('client_secret'), APP_SECRET);
      return token(w.tokenCalls);
    }
    if (u === `https://api.twitch.tv/helix/streams?user_id=${BROADCASTER}`) {
      const h = init.headers || {};
      w.helixCalls.push({ clientId: h['Client-Id'], auth: h.Authorization });
      return helix(w.helixCalls.length, h);
    }
    if (u.startsWith('https://id.twitch.tv/oauth2/validate')) throw new Error('the app path must not validate a bot token');
    w.unexpected.push(`${method} ${u}`);
    throw new Error(`unexpected request: ${method} ${u}`);
  };
  return w;
}
const mint = (n) => json({ access_token: `app-token-${n}`, expires_in: 5000000, token_type: 'bearer' });

test('setup: the schema lets this process read the Twitch app pair', () => {
  assert.ok(instanceEntry('twitch.clientId').packages.includes('stream-ingest'), 'twitch.clientId must list stream-ingest');
  assert.ok(instanceEntry('twitch.clientSecret').packages.includes('stream-ingest'), 'twitch.clientSecret must list stream-ingest');
});

// Order matters below: the app token is cached across tests, as it is across ticks.

test('no bot token, the wizard\'s app pair: live, from a client-credentials app token', async () => {
  const w = world({ token: mint, helix: () => json({ data: [{ viewer_count: 9 }] }) });
  try {
    assert.equal(await instanceConfig.load(), true, 'the settings arrive from stream-api');
    assert.deepEqual(await twitchStatus(), { state: 'live', viewers: 9 });
    assert.equal(w.tokenCalls, 1);
    assert.deepEqual(w.helixCalls[0], { clientId: APP_ID, auth: 'Bearer app-token-1' }, 'Helix is asked with the app\'s own client id and token');
  } finally { global.fetch = realFetch; }
});

test('a confirmed offline, and the app token is reused, not minted per tick', async () => {
  const w = world({ token: mint, helix: () => json({ data: [] }) });
  try {
    assert.deepEqual(await twitchStatus(), { state: 'offline', viewers: 0 });
    assert.deepEqual(await twitchStatus(), { state: 'offline', viewers: 0 });
    assert.equal(w.tokenCalls, 0, 'the cached token from the last test is still good');
    assert.equal(w.helixCalls.at(-1).auth, 'Bearer app-token-1');
  } finally { global.fetch = realFetch; }
});

test('an expired app token: a 401 mints a new one and asks again, once', async () => {
  const w = world({
    token: (n) => mint(n + 1), // the second token this process has seen
    helix: (n, h) => (h.Authorization === 'Bearer app-token-1' ? json({ status: 401, message: 'Invalid OAuth token' }, 401) : json({ data: [{ viewer_count: 3 }] })),
  });
  try {
    assert.deepEqual(await twitchStatus(), { state: 'live', viewers: 3 });
    assert.equal(w.tokenCalls, 1, 'one re-mint');
    assert.deepEqual(w.helixCalls.map((c) => c.auth), ['Bearer app-token-1', 'Bearer app-token-2']);
  } finally { global.fetch = realFetch; }
});

test('a 401 that survives the re-mint is unknown, never offline', async () => {
  const w = world({ token: (n) => mint(n + 10), helix: () => json({ status: 401, message: 'Invalid OAuth token' }, 401) });
  try {
    assert.equal((await twitchStatus()).state, 'unknown');
    assert.equal(w.helixCalls.length, 2, 'one retry, not a loop');
  } finally { global.fetch = realFetch; }
});

test('Twitch unavailable: an HTTP 5xx, a network error, or a token endpoint that fails is unknown', async () => {
  let w = world({ token: mint, helix: () => json({ message: 'unavailable' }, 503) });
  try { assert.equal((await twitchStatus()).state, 'unknown'); } finally { global.fetch = realFetch; }
  w = world({ token: mint, helix: () => { throw new Error('ETIMEDOUT'); } });
  try { assert.equal((await twitchStatus()).state, 'unknown'); } finally { global.fetch = realFetch; }
  // Force a re-mint (a 401), then have the token endpoint fail.
  w = world({ token: () => json({ message: 'down' }, 500), helix: () => json({ status: 401 }, 401) });
  try {
    assert.equal((await twitchStatus()).state, 'unknown');
    assert.equal(w.tokenCalls, 1);
  } finally { global.fetch = realFetch; }
  w = world({ token: () => json({ message: 'down' }, 500), helix: () => json({ data: [] }) });
  try {
    assert.equal((await twitchStatus()).state, 'unknown', 'no token to ask with is not an answer');
    assert.equal(w.helixCalls.length, 0);
  } finally { global.fetch = realFetch; }
});

test('the real poller opens a session from the app pair alone', async () => {
  const w = world({ token: mint, helix: () => json({ data: [{ viewer_count: 5 }] }) });
  const poller = startPoller({ getStreamplaceViewers: () => null, getYtVideoId: () => '' });
  try {
    const t0 = Date.now();
    while (w.api.snapshots.length < 2) {
      if (Date.now() - t0 > 3000) throw new Error('timed out waiting for snapshots');
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(w.api.starts.length, 1);
    assert.equal(w.api.snapshots.at(-1).twitch, 5);
    assert.deepEqual(w.unexpected, [], 'no request for a platform this install has not set up (YouTube, Kick)');
  } finally { poller.stop(); global.fetch = realFetch; }
});
