// The REAL poller on a YouTube install with no Data API key.
//
// A key is optional for YouTube: liveness comes from the chat watcher's verified video id and the
// count from the zero-quota InnerTube "watching now", so startPoller() must run without a key (or
// a Twitch bot token) or such an install never opens a session. This drives the
// actual timer loop with the watcher's id and a fake InnerTube, and asserts start once, snapshots
// carrying the count and the verified id, and an end only after two consecutive offline readings.
// No request may go to the paid Data API: there is no key to send.
//
// Run: node --test lib/pollerYoutubeKeyless.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
process.env.YOUTUBE_CHANNEL_ID = 'UCcaseytestchannel00000';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
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
const watching = (n) => ({ actions: [{ updateViewershipAction: { viewCount: { videoViewCountRenderer: { isLive: true, viewCount: { runs: [{ text: `${n} watching now` }] } } } } }] });

test('YouTube without a key: the poller runs, opens a session, snapshots, and ends it debounced', async () => {
  const api = { live: false, streamId: null, starts: [], ends: [], snapshots: [] };
  let watcherId = 'abcdefghijk';
  let currentReads = 0;
  let readsAtFirstOffline = null;
  let readsAtEnd = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith('https://www.youtube.com/youtubei/v1/updated_metadata')) return json(watching(17));
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') { currentReads += 1; return json({ live: api.live, streamId: api.streamId }); }
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { api.snapshots.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); readsAtEnd = currentReads; return json({ ok: true }); }
    }
    throw new Error(`unexpected request in a keyless YouTube install: ${method} ${u}`);
  };
  const poller = startPoller({ getStreamplaceViewers: () => null, getYtVideoId: () => watcherId });
  try {
    await until(() => api.snapshots.length >= 3, 'three viewer snapshots while YouTube is live');
    assert.equal(api.starts.length, 1, 'one session, not one per tick');
    const last = api.snapshots.at(-1);
    assert.equal(last.youtube, 17, 'the InnerTube count, with no key');
    assert.equal(last.ytVideoId, 'abcdefghijk', 'the watcher\'s verified id rides along');
    assert.equal(last.streamId, api.starts[0]);

    readsAtFirstOffline = currentReads;
    watcherId = '';
    await until(() => api.ends.length === 1, 'the session to end');
    // The tick in flight when the id went away may already have read it; the end must still need
    // two offline readings, so it lands no sooner than the second tick after the switch.
    assert.ok(readsAtEnd - readsAtFirstOffline >= 2, `ended after ${readsAtEnd - readsAtFirstOffline} tick(s) — one offline reading must not end it`);
    assert.deepEqual(api.ends, api.starts);
    const r = currentReads;
    await until(() => currentReads >= r + 3, 'more offline ticks');
    assert.equal(api.ends.length, 1, 'an ended session is not ended again');
  } finally {
    poller.stop();
    global.fetch = realFetch;
  }
});
