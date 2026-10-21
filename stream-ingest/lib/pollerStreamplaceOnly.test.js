// The REAL poller on a stream.place-only install.
//
// Without stream.place's live vote, an install whose only channel is stream.place would print
// "no platform configured for live status" and never open a session: no live player, a timer
// that never runs, no watch points, no reminders. This drives the actual timer loop
// with the reader's vote and a fake stream-api: start once, snapshots carrying stream.place's count,
// an end only after two offline readings, and an `unknown` (socket down) that never ends anything.
//
// Run: node --test lib/pollerStreamplaceOnly.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { startPoller } = await import('./poller.js');

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const until = async (pred, what, ms = 3000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('stream.place-only: the reader\'s vote opens a session, snapshots its count, and ends it debounced', async () => {
  const api = { live: false, streamId: null, starts: [], ends: [], snapshots: [] };
  let sp = 'live';
  let reads = 0;
  let readsAtOffline = null;
  let readsAtEnd = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') { reads += 1; return json({ live: api.live, streamId: api.streamId }); }
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { api.snapshots.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); readsAtEnd = reads; return json({ ok: true }); }
    }
    throw new Error(`unexpected request on a stream.place-only install: ${method} ${u}`);
  };
  const poller = startPoller({ getStreamplaceViewers: () => 7, getStreamplaceState: () => sp, getYtVideoId: () => null, ytWanted: () => false });
  try {
    await until(() => api.snapshots.length >= 3, 'three snapshots while stream.place is live');
    assert.equal(api.starts.length, 1, 'one session');
    assert.equal(api.snapshots.at(-1).streamplace, 7);

    // A socket that is down votes unknown: nothing ends, however long it lasts.
    sp = 'unknown';
    const r0 = reads;
    await until(() => reads >= r0 + 5, 'ticks while unknown');
    assert.equal(api.ends.length, 0, 'an unknown reading ended the session');

    sp = 'offline';
    readsAtOffline = reads;
    await until(() => api.ends.length === 1, 'the session to end');
    assert.ok(readsAtEnd - readsAtOffline >= 2, `ended after ${readsAtEnd - readsAtOffline} tick(s) — one offline reading must not end it`);
    assert.deepEqual(api.ends, api.starts);
  } finally {
    poller.stop();
    global.fetch = realFetch;
  }
});
