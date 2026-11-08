// The REAL poller with no platform configured (the other side of pollerKickOnly.test.js).
//
// The poller always runs and decides each tick which platforms vote. With none configured it
// must stay out of the way: no provider request, no session read, and above all no end of a
// session someone opened by hand (YouTube's empty watcher id would read as "offline" if YouTube
// were allowed to vote without a channel). Its one request is the per-tick publish of its states —
// `platforms: {}` — so stream-api knows the poller is alive with nothing to say (Task 6).
//
// Run: node --test lib/pollerUnconfigured.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { startPoller } = await import('./poller.js');

test('no platform configured: the poller asks nothing and publishes `platforms: {}` each tick', async () => {
  const requests = [];
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const r = `${init.method || 'GET'} ${url}`;
    if (r === 'POST http://stream-api.test/stream/platforms') {
      bodies.push(JSON.parse(init.body));
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    requests.push(r);
    throw new Error('no request expected');
  };
  const poller = startPoller({ getStreamplaceViewers: () => null, getYtVideoId: () => '' });
  try {
    await new Promise((r) => setTimeout(r, 60)); // a dozen ticks at 5 ms
    assert.deepEqual(requests, [], 'nothing to ask, so nothing is asked — and a hand-opened session cannot be ended');
    assert.ok(bodies.length >= 2, `a publish per tick (${bodies.length})`);
    for (const b of bodies) assert.deepEqual(b.platforms, {}, 'nothing configured: an empty set, not nulls');
  } finally {
    poller.stop();
    global.fetch = realFetch;
  }
});
