// YouTube's live vote with NO chat reader running.
//
// If a reader unable to start (no browser in the image) handed the poller '', YouTube would vote
// OFFLINE every tick — a YouTube-only install would never go live, and a live YouTube stream could
// be closed by the other platforms. A missing reader is null, and the poller asks YouTube itself with the same zero-quota lookup; a lookup that fails
// votes unknown. The real poller loop, a fake YouTube and a fake stream-api.
//
// Run: node --test lib/pollerYoutubeNoReader.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
process.env.YOUTUBE_CHANNEL_ID = 'UCcaseytestchannel00000';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'YOUTUBE_VIDEO_ID', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { startPoller, youtubeReading } = await import('./poller.js');

const CH = 'UCcaseytestchannel00000';
const VID = 'abcdefghijk';
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const html = (s) => new Response(s, { status: 200, headers: { 'content-type': 'text/html' } });
const until = async (pred, what, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};
const watchPage = (live) => html(`<script>var ytInitialPlayerResponse = ${JSON.stringify({
  videoDetails: { channelId: CH },
  microformat: { playerMicroformatRenderer: { externalChannelId: CH, liveBroadcastDetails: { isLiveNow: live } } },
})};</script>`);
const watching = (n) => ({ actions: [{ updateViewershipAction: { viewCount: { videoViewCountRenderer: { isLive: true, viewCount: { runs: [{ text: `${n} watching now` }] } } } } }] });

test('no reader + YouTube chosen: the poller\'s own lookup opens the session, snapshots it, and a failing lookup never ends it', async () => {
  const api = { live: false, streamId: null, starts: [], ends: [], snapshots: [] };
  let yt = 'live'; // 'live' | 'offline' | 'down'
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith(`https://www.youtube.com/channel/${CH}/live`)) {
      if (yt === 'down') throw new Error('ECONNRESET');
      return html(yt === 'live' ? `<link rel="canonical" href="https://www.youtube.com/watch?v=${VID}">` : '<html>no stream</html>');
    }
    if (u.startsWith(`https://www.youtube.com/watch?v=${VID}`)) {
      if (yt === 'down') throw new Error('ECONNRESET');
      return watchPage(yt === 'live');
    }
    if (u.startsWith('https://www.youtube.com/youtubei/v1/updated_metadata')) return json(watching(23));
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') { api.reads = (api.reads || 0) + 1; return json({ live: api.live, streamId: api.streamId }); }
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { api.snapshots.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); return json({ ok: true }); }
    }
    throw new Error(`unexpected request: ${method} ${u}`);
  };
  const realWarn = console.warn;
  console.warn = () => {};
  const poller = startPoller({ getStreamplaceViewers: () => null, getStreamplaceState: () => null, getYtVideoId: () => null, ytWanted: () => true });
  try {
    await until(() => api.snapshots.length >= 3, 'snapshots while YouTube is live');
    assert.equal(api.starts.length, 1);
    assert.equal(api.snapshots.at(-1).youtube, 23);
    assert.equal(api.snapshots.at(-1).ytVideoId, VID, 'the verified id rides along');

    yt = 'down';
    const n = api.reads;
    await until(() => api.reads >= n + 5, 'ticks while YouTube cannot be asked');
    assert.equal(api.ends.length, 0, 'a failed lookup voted offline');

    yt = 'offline';
    await until(() => api.ends.length === 1, 'the session to end once YouTube says offline');
    assert.deepEqual(api.ends, api.starts);
  } finally {
    poller.stop();
    global.fetch = realFetch;
    console.warn = realWarn;
  }
});

test('youtubeReading: the reader\'s id when one runs; nothing at all when YouTube is not chosen', async () => {
  const lookup = async () => { throw new Error('must not be asked'); };
  assert.deepEqual(await youtubeReading({ watcher: VID, wanted: true, channelId: CH, lookup }), { raw: 'live', videoId: VID });
  assert.deepEqual(await youtubeReading({ watcher: '', wanted: true, channelId: CH, lookup }), { raw: 'offline', videoId: '' });
  assert.equal(await youtubeReading({ watcher: null, wanted: false, channelId: CH, lookup }), null, 'not chosen: no vote');
  assert.equal(await youtubeReading({ watcher: null, wanted: true, channelId: '', lookup }), null, 'no channel: no vote');
  assert.deepEqual(await youtubeReading({ watcher: null, wanted: true, channelId: CH, lookup: async () => ({ state: 'unknown', videoId: '' }) }), { raw: 'unknown', videoId: '' });
});
