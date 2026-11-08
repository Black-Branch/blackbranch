// ADR 0133, one real execution: the REAL poller loop (startPoller, its timers, its miss counter, a
// fake stream-api over fetch) reading a YouTube reader whose vote flips live → offline while its
// chat page is still open and delivering the tail. The night must end on the second offline tick —
// the tail is read, but it is not liveness.
//
// Run: node --test lib/pollerYtVote.test.js

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

const { startPoller } = await import('./poller.js');

const VID = 'abcdefghijk';
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const watching = (n) => ({ actions: [{ updateViewershipAction: { viewCount: { videoViewCountRenderer: { isLive: true, viewCount: { runs: [{ text: `${n} watching now` }] } } } } }] });
const until = async (pred, what, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
};

/**
 * The reader's handle as platforms/youtube.js shapes it (Task 4: getLiveState, an Observation plus
 * the verified live id): the page stays open on VID throughout. `certain` is the end's certainty.
 */
function stubReader() {
  const r = {
    vote: 'live',
    certain: false,
    chatDelivered: 0,
    getLiveState: () => {
      r.chatDelivered += 1;
      const live = r.vote === 'live';
      return {
        raw: r.vote,
        certain: r.vote === 'offline' && r.certain,
        key: live || r.vote === 'upcoming' ? VID : '',
        evidence: live ? 'is-live' : r.vote === 'offline' ? (r.certain ? 'not-live' : 'channel-canonical') : r.vote === 'upcoming' ? 'upcoming' : 'sticky-check-failed',
        scheduledStart: r.vote === 'upcoming' ? Date.now() + 30 * 60_000 : null,
        videoId: live ? VID : '',
      };
    },
  };
  return r;
}

function fakeWorld({ ytEnded = () => false } = {}) {
  const api = { live: false, streamId: null, starts: [], ends: [], snapshots: [], reads: 0, endAtRead: null, onRead: null };
  const real = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.startsWith('https://www.youtube.com/youtubei/v1/updated_metadata')) {
      // An ended broadcast's renderer carries the cumulative total, isLive false.
      return json(ytEnded() ? { actions: [{ updateViewershipAction: { viewCount: { videoViewCountRenderer: { isLive: false, viewCount: { simpleText: '1,234 views' } } } } }] } : watching(9));
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') { api.reads += 1; api.onRead?.(); return json({ live: api.live, streamId: api.streamId }); }
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/platforms') return json({ ok: true }); // the per-tick publish (pollerPublish.test.js)
      if (method === 'POST' && path === '/viewer-snapshot') { api.snapshots.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); api.endAtRead = api.reads; return json({ ok: true }); }
    }
    throw new Error(`unexpected request: ${method} ${u}`);
  };
  return { api, restore: () => { global.fetch = real; } };
}

test('the reader votes offline while its chat tail still delivers: the real poller ends the night on the second offline tick', async () => {
  const { api, restore } = fakeWorld();
  const reader = stubReader();
  // The vote is flipped from INSIDE the stream-api read so the switch lands on a tick boundary.
  const poller = startPoller({
    getStreamplaceViewers: () => null, getStreamplaceObservation: () => null, ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.snapshots.length >= 2, 'snapshots while live');
    assert.equal(api.starts.length, 1);
    assert.equal(api.snapshots.at(-1).ytVideoId, VID);
    // Flip on a tick boundary: inside a tick's stream-api read, after that tick has read the vote, so
    // the next tick is the first offline one. Each tick reads the vote once and then stream-api once,
    // so the read count after the flip counts offline ticks exactly.
    const snapsBefore = api.snapshots.length;
    let flipAt = null;
    api.onRead = () => { reader.vote = 'offline'; flipAt = api.reads; api.onRead = null; };
    await until(() => api.ends.length === 1, 'the session to end');
    // An uncertain end needs its 2nd offline reading: exactly two ticks after the flip.
    assert.equal(api.endAtRead - flipAt, 2, 'an uncertain end lands on the second offline tick');
    assert.deepEqual(api.ends, api.starts);
    assert.ok(api.snapshots.length - snapsBefore <= 2, 'at most the in-flight and first-offline ticks snapshot');
    assert.ok(api.snapshots.slice(snapsBefore).every((s) => s.ytVideoId === null || s.ytVideoId === VID));
    assert.ok(reader.chatDelivered > 0, 'the reader was read every tick (its chat still open)');
  } finally {
    poller.stop();
    restore();
  }
});

test('retry: a reader whose lookups fail (unknown, chat closed) never ends the night; it ends once YouTube answers offline', async () => {
  const { api, restore } = fakeWorld();
  const reader = stubReader();
  const warn = console.warn;
  console.warn = () => {};
  const poller = startPoller({
    getStreamplaceViewers: () => null, getStreamplaceObservation: () => null, ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.starts.length === 1 && api.snapshots.length >= 1, 'a live session');
    reader.vote = 'unknown';
    const n = api.reads;
    await until(() => api.reads >= n + 6, 'ticks while the reader cannot tell');
    assert.equal(api.ends.length, 0, 'unknown voted offline');
    reader.vote = 'live';
    const m = api.reads;
    await until(() => api.reads >= m + 2, 'ticks after the lookup recovered');
    assert.equal(api.starts.length, 1, 'the recovered stream continued the same session');
    reader.vote = 'offline';
    await until(() => api.ends.length === 1, 'the session to end');
  } finally {
    poller.stop();
    restore();
    console.warn = warn;
  }
});

test('another platform still live: from YouTube\'s answered end the snapshots carry no YouTube count and no id (no 5-minute stale count)', async () => {
  const reader = stubReader();
  const { api, restore } = fakeWorld({ ytEnded: () => reader.vote === 'offline' });
  const poller = startPoller({
    getStreamplaceViewers: () => 3, getStreamplaceObservation: () => ({ raw: 'live', certain: false, key: 'at://sp-test', evidence: 'record-live' }), ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.snapshots.length >= 2, 'snapshots while both are live');
    assert.equal(api.snapshots.at(-1).youtube, 9);
    reader.vote = 'offline';
    const n = api.snapshots.length;
    await until(() => api.snapshots.length >= n + 4, 'snapshots after YouTube ended');
    // The first one may come from the tick in flight at the flip.
    for (const s of api.snapshots.slice(n + 1)) {
      assert.equal(s.youtube, null, 'an ended broadcast\'s last count was served');
      assert.equal(s.ytVideoId, null);
    }
    assert.equal(api.ends.length, 0, 'stream.place keeps the night open');
  } finally {
    poller.stop();
    restore();
  }
});

// Task 4: a scheduled broadcast is handled like an end by the viewer count (youtubeViewers): the
// sticky id and the last good count are dropped, so no count is served for a countdown.
test('another platform still live and YouTube goes back to a countdown: no YouTube count, no id', async () => {
  const reader = stubReader();
  const { api, restore } = fakeWorld({ ytEnded: () => reader.vote === 'upcoming' });
  const poller = startPoller({
    getStreamplaceViewers: () => 3, getStreamplaceObservation: () => ({ raw: 'live', certain: false, key: 'at://sp-test', evidence: 'record-live' }), ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.snapshots.length >= 2, 'snapshots while both are live');
    assert.equal(api.snapshots.at(-1).youtube, 9);
    reader.vote = 'upcoming';
    const n = api.snapshots.length;
    await until(() => api.snapshots.length >= n + 4, 'snapshots during the countdown');
    for (const s of api.snapshots.slice(n + 1)) {
      assert.equal(s.youtube, null, 'a countdown was served the last live count');
      assert.equal(s.ytVideoId, null);
    }
    assert.equal(api.ends.length, 0, 'stream.place keeps the night open');
  } finally {
    poller.stop();
    restore();
  }
});

// Task 4: the reader's certain end — the known video's own page answering not-live (or the Data
// API's none / actualEndTime) — counts at once (ADR 0134 E7): the night ends on the FIRST offline
// tick, not the second.
test('a certain YouTube end ends the night on the first offline tick', async () => {
  const { api, restore } = fakeWorld();
  const reader = stubReader();
  const poller = startPoller({
    getStreamplaceViewers: () => null, getStreamplaceObservation: () => null, ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.snapshots.length >= 2, 'snapshots while live');
    // Flipped on a tick boundary (inside a stream-api read), as in the first test.
    let flipAt = null;
    api.onRead = () => { reader.certain = true; reader.vote = 'offline'; flipAt = api.reads; api.onRead = null; };
    await until(() => api.ends.length === 1, 'the session to end');
    assert.equal(api.endAtRead - flipAt, 1, 'a certain end lands on the FIRST offline tick');
    assert.deepEqual(api.ends, api.starts);
  } finally {
    poller.stop();
    restore();
  }
});

// A scheduled broadcast — our own countdown, its chat being read — never opens a night, and one
// scheduled right after the end does not hold it open (ADR 0133's split; controller ruling 7).
test('the countdown never opens a session; it goes live → a session; scheduled again after the end → the night still ends', async () => {
  const { api, restore } = fakeWorld();
  const reader = stubReader();
  reader.vote = 'upcoming';
  const poller = startPoller({
    getStreamplaceViewers: () => null, getStreamplaceObservation: () => null, ytWanted: () => true,
    getYtVideoId: () => reader.getLiveState().videoId, getYtLiveState: () => reader.getLiveState(),
  });
  try {
    await until(() => api.reads >= 6, 'ticks through the countdown');
    assert.equal(api.starts.length, 0, 'a countdown opened a session');
    assert.equal(api.snapshots.length, 0);
    reader.vote = 'live';
    await until(() => api.starts.length === 1 && api.snapshots.length >= 1, 'the session at live');
    reader.vote = 'upcoming';
    await until(() => api.ends.length === 1, 'the end, with the next broadcast already scheduled');
    assert.deepEqual(api.ends, api.starts);
  } finally {
    poller.stop();
    restore();
  }
});
