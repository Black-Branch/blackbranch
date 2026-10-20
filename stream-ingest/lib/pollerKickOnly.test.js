// The REAL poller on a Kick-only install (external review, finding A).
//
// startPoller() used to admit itself only when a Twitch bot token or a YouTube Data API key was
// present, so an install whose only channel is Kick connected chat but never opened a session,
// never recorded a viewer snapshot and never closed one: the poller printed "idle" and made no
// request at all. This drives the actual timer loop against a fake Kick and a fake stream-api and
// asserts the whole lifecycle: start once, snapshots with Kick's count, and an end only after the
// second consecutive offline answer (the miss-counter debounce).
//
// Run: node --test lib/pollerKickOnly.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

// Before importing: the token module and the settings layer read env. Nothing but Kick is set.
process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
process.env.KICK_CHANNEL_SLUG = 'casey-test';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { startPoller } = await import('./poller.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const until = async (pred, what, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('Kick-only: the poller runs, opens a session, snapshots Kick, and ends it debounced', async () => {
  const api = { live: false, streamId: null, starts: [], ends: [], snapshots: [] };
  let kickLive = true;
  let kickOfflineAnswers = 0;
  let endedAfterOfflineAnswers = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u === 'https://kick.com/api/v2/channels/casey-test') {
      if (kickLive) return json({ livestream: { is_live: true, viewer_count: 42 } });
      kickOfflineAnswers += 1;
      return json({ livestream: null });
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') return json({ live: api.live, streamId: api.streamId });
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { api.snapshots.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); endedAfterOfflineAnswers = kickOfflineAnswers; return json({ ok: true }); }
    }
    throw new Error(`unexpected request in a Kick-only install: ${method} ${u}`);
  };
  // index.js always hands the poller this getter; with no YouTube reader it answers ''.
  const poller = startPoller({ getStreamplaceViewers: () => null, getYtVideoId: () => '' });
  try {
    await until(() => api.snapshots.length >= 3, 'three viewer snapshots while Kick is live');
    assert.equal(api.starts.length, 1, 'one session, not one per tick');
    assert.equal(api.snapshots.at(-1).kick, 42, 'the snapshot carries Kick\'s count');
    assert.equal(api.snapshots.at(-1).twitch, null);
    assert.equal(api.snapshots.at(-1).streamId, api.starts[0]);

    kickLive = false;
    await until(() => api.ends.length === 1, 'the session to end');
    assert.equal(endedAfterOfflineAnswers, 2, 'one offline answer is a miss; the second consecutive one ends the session');
    assert.deepEqual(api.ends, api.starts);
    const answersAtEnd = kickOfflineAnswers;
    await until(() => kickOfflineAnswers >= answersAtEnd + 3, 'more offline ticks');
    assert.equal(api.ends.length, 1, 'an ended session is not ended again');
    assert.equal(api.starts.length, 1);
  } finally {
    poller.stop();
    global.fetch = realFetch;
  }
});
