// The waiting room, one real execution (Task 4 Step 5; ADR 0133's split, 0134 E4/E12).
//
// The REAL watcher (platforms/youtube.js createYtWatcher: the real youtubeLiveState over a mocked
// fetch, the real chatPlan / decideWatch / watcherVote, the real E12 confirm against a fake Data
// API) with the chat page stubbed, ticked through our own scheduled broadcast:
//   upcoming (+90 min) → upcoming (+30 min) → upcoming (+29 min) → live → ended (certain).
// The countdown chat opens once, at +30 min (inside YT_WAITING_ROOM_MS); it never votes live; the
// page carries on into the live chat and stays open through the tail; a relay never reads a
// countdown; and the confirm spends at most one unit per state change.
//
// Run: node --test lib/ytWaitingRoom.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.YOUTUBE_VIDEO_ID;
const { createYtWatcher, createYtConfirm } = await import('../platforms/youtube.js');
const { YT_WAITING_ROOM_MS } = await import('./ytEndDecision.js');

const CH = 'UCcaseytestchannel00000';
const X = 'abcdefghijk';
const MIN = 60_000;
const S = Date.parse('2026-10-24T20:00:00Z'); // the scheduled start
const html = (s) => new Response(s, { status: 200, headers: { 'content-type': 'text/html' } });
const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

// The pages as config/youtube-live.mjs reads them (fixtures/youtube/upcoming-watch.html's shape).
const player = (phase) => {
  const base = { videoDetails: { videoId: X, channelId: CH }, microformat: { playerMicroformatRenderer: { externalChannelId: CH } } };
  if (phase === 'upcoming') {
    base.videoDetails.isUpcoming = true;
    base.playabilityStatus = { status: 'LIVE_STREAM_OFFLINE', liveStreamability: { liveStreamabilityRenderer: { videoId: X,
      offlineSlate: { liveStreamOfflineSlateRenderer: { scheduledStartTime: String(S / 1000) } } } } };
    base.microformat.playerMicroformatRenderer.liveBroadcastDetails = { isLiveNow: false };
  } else if (phase === 'live') {
    base.videoDetails.isLive = true;
    base.playabilityStatus = { status: 'OK' };
    base.microformat.playerMicroformatRenderer.liveBroadcastDetails = { isLiveNow: true };
  } else {
    base.playabilityStatus = { status: 'OK' };
    base.microformat.playerMicroformatRenderer.liveBroadcastDetails = { isLiveNow: false };
  }
  return `<link rel="canonical" href="https://www.youtube.com/watch?v=${X}"><script>var ytInitialPlayerResponse = ${JSON.stringify(base)};</script>`;
};
const apiItem = (phase) => ({ items: [{ id: X,
  snippet: { liveBroadcastContent: phase === 'ended' ? 'none' : phase },
  liveStreamingDetails: { scheduledStartTime: new Date(S).toISOString(), ...(phase === 'ended' ? { actualEndTime: new Date(S + 3 * 60 * MIN).toISOString() } : {}) } }] });

/** One world: the phase YouTube is in, the clock, and every request counted by kind. */
function world() {
  const w = { phase: 'upcoming', now: 0, pages: 0, api: 0, down: false };
  const real = { fetch: global.fetch, warn: console.warn, log: console.log };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/youtube/v3/videos?')) { w.api += 1; return json(apiItem(w.phase)); }
    if (u.startsWith(`https://www.youtube.com/channel/${CH}/live`) || u.startsWith(`https://www.youtube.com/watch?v=${X}`)) {
      w.pages += 1;
      if (w.down) throw new Error('ECONNRESET');
      return html(player(w.phase));
    }
    throw new Error(`unexpected request: ${u}`);
  };
  console.warn = () => {};
  console.log = () => {};
  w.restore = () => { global.fetch = real.fetch; console.warn = real.warn; console.log = real.log; };
  return w;
}

/** The chat page, stubbed: what the watcher asked of it. */
function stubChat() {
  const c = { opens: [], closes: 0, supervised: 0, msSinceOk: 1_000 };
  return {
    c,
    chat: {
      open: async (videoId, { live }) => { c.opens.push({ videoId, live }); },
      close: async () => { c.closes += 1; },
      msSinceOk: () => c.msSinceOk,
      supervise: async () => { c.supervised += 1; },
    },
  };
}

const STEPS = [
  [S - 90 * MIN, 'upcoming'],
  [S - 30 * MIN, 'upcoming'],
  [S - 29 * MIN, 'upcoming'],
  [S + 1 * MIN, 'live'],
  [S + 3 * 60 * MIN, 'ended'],
];

async function run({ relay = false, key = '' } = {}) {
  const w = world();
  const { c, chat } = stubChat();
  const confirm = createYtConfirm({ apiKey: () => key, now: () => w.now }).confirmViaApi;
  const watcher = createYtWatcher({ channelId: CH, relay, chat, confirm, now: () => w.now });
  const seen = [];
  try {
    for (const [t, phase] of STEPS) {
      w.now = t;
      w.phase = phase;
      const opensBefore = c.opens.length;
      const apiBefore = w.api;
      await watcher.tick();
      seen.push({ t, phase, state: watcher.getLiveState(), opened: c.opens.length > opensBefore, chatLive: watcher.chatIsLive(),
        chatVideoId: watcher.chatVideoId(), units: w.api - apiBefore });
    }
  } finally { w.restore(); }
  return { seen, c, w };
}

test('the countdown: one openChat, at +30 min; the vote reads upcoming ×3, live, offline; the page stays open after the end', async () => {
  const { seen, c } = await run();
  assert.deepEqual(c.opens, [{ videoId: X, live: false }], 'one open, for the countdown, not live');
  assert.deepEqual(seen.map((s) => s.opened), [false, true, false, false, false], 'opened at +30 min, not before, not again at live');
  assert.ok(S - seen[1].t <= YT_WAITING_ROOM_MS && S - seen[0].t > YT_WAITING_ROOM_MS);
  assert.deepEqual(seen.map((s) => s.state.raw), ['upcoming', 'upcoming', 'upcoming', 'live', 'offline']);
  // The countdown never votes live, carries its start and its id; the end is the known video's own answer.
  for (const s of seen.slice(0, 3)) {
    assert.equal(s.state.scheduledStart, S);
    assert.equal(s.state.key, X);
    assert.equal(s.state.videoId, '', 'no id rides a snapshot during the countdown');
  }
  assert.equal(seen[3].state.videoId, X);
  assert.deepEqual({ certain: seen[4].state.certain, evidence: seen[4].state.evidence, videoId: seen[4].state.videoId },
    { certain: true, evidence: 'not-live', videoId: '' });
  // The page: open from +30 min, carried into the live chat, still open in the tail.
  assert.deepEqual(seen.map((s) => s.chatVideoId), [null, X, X, X, X]);
  assert.equal(c.closes, 0, 'the tail is read: the page stays open after the end');
  // The 1 s self-poll starts at live; the countdown reads at YouTube's own timeoutMs.
  assert.deepEqual(seen.map((s) => s.chatLive), [false, false, false, true, true]);
});

test('in relay mode a countdown is never read: no openChat during it; the chat opens only when the broadcast is live', async () => {
  const { seen, c } = await run({ relay: true });
  assert.deepEqual(seen.slice(0, 3).map((s) => s.opened), [false, false, false], 'a relay opened a countdown chat');
  assert.deepEqual(c.opens, [{ videoId: X, live: true }], 'the only open is the live one');
  assert.deepEqual(seen.map((s) => s.state.raw), ['upcoming', 'upcoming', 'upcoming', 'live', 'offline']);
});

test('E12 with a key: one 1-unit confirm per YouTube state change and none in between; the API\'s end is certain', async () => {
  const { seen, w } = await run({ key: 'test-api-key-not-real' });
  // A change against the last accepted state: (none) → upcoming, upcoming → live, live → offline.
  assert.deepEqual(seen.map((s) => s.units), [1, 0, 0, 1, 1]);
  assert.equal(w.api, 3);
  assert.ok(seen.every((s) => s.units <= 1), 'never more than one unit in a tick');
  assert.deepEqual({ raw: seen[4].state.raw, certain: seen[4].state.certain, evidence: seen[4].state.evidence },
    { raw: 'offline', certain: true, evidence: 'api-confirmed' });
  assert.deepEqual(seen.map((s) => s.state.raw), ['upcoming', 'upcoming', 'upcoming', 'live', 'offline']);
});

test('E12 never runs for a relay (other channels do not vote), key or not', async () => {
  const { w } = await run({ relay: true, key: 'test-api-key-not-real' });
  assert.equal(w.api, 0);
});

test('the waiting room does not burn the quota: an hour of countdown ticks (every 30 s) costs one unit', async () => {
  const w = world();
  const { c, chat } = stubChat();
  const confirm = createYtConfirm({ apiKey: () => 'test-api-key-not-real', now: () => w.now }).confirmViaApi;
  const watcher = createYtWatcher({ channelId: CH, chat, confirm, now: () => w.now });
  try {
    for (let t = S - 70 * MIN; t < S; t += 30_000) { w.now = t; await watcher.tick(); }
    assert.equal(w.api, 1);
    assert.equal(c.opens.length, 1);
    assert.equal(watcher.getLiveState().raw, 'upcoming');
  } finally { w.restore(); }
});

// Review I1: the countdown chat on X is open and the channel goes live on ANOTHER video Y (an early
// start on a new broadcast, or an overdue schedule chatPlan also opens). /live must still be read
// during the countdown, and the reader hand over to Y's live chat.
test('upcoming X with its countdown open, then live on another video Y → live, key = Y; Y\'s chat opens once', async () => {
  const Y = 'newbroadcst';
  const w = { yLive: false, now: S - 20 * MIN, liveReads: 0 };
  const real = { fetch: global.fetch, warn: console.warn, log: console.log };
  const yPage = (live) => `<link rel="canonical" href="https://www.youtube.com/watch?v=${Y}"><script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { videoId: Y, channelId: CH, ...(live ? { isLive: true } : {}) },
    playabilityStatus: { status: 'OK' },
    microformat: { playerMicroformatRenderer: { externalChannelId: CH, liveBroadcastDetails: { isLiveNow: live } } },
  })};</script>`;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith(`https://www.youtube.com/channel/${CH}/live`)) {
      w.liveReads += 1;
      return html(w.yLive ? yPage(true) : player('upcoming'));
    }
    if (u.startsWith(`https://www.youtube.com/watch?v=${X}`)) return html(player('upcoming'));
    if (u.startsWith(`https://www.youtube.com/watch?v=${Y}`)) return html(yPage(w.yLive));
    throw new Error(`unexpected request: ${u}`);
  };
  console.warn = () => {};
  console.log = () => {};
  const { c, chat } = stubChat();
  const watcher = createYtWatcher({ channelId: CH, chat, confirm: async () => null, now: () => w.now });
  try {
    await watcher.tick();
    assert.deepEqual(c.opens, [{ videoId: X, live: false }], 'the countdown opened');
    const reads = w.liveReads;
    for (let i = 0; i < 4; i++) { w.now += 30_000; await watcher.tick(); }
    assert.ok(w.liveReads >= reads + 4, `/live was read ${w.liveReads - reads}× in 4 countdown ticks`);
    assert.equal(watcher.getLiveState().raw, 'upcoming');
    w.yLive = true;
    w.now += 30_000;
    await watcher.tick();
    const s = watcher.getLiveState();
    assert.deepEqual({ raw: s.raw, key: s.key, videoId: s.videoId }, { raw: 'live', key: Y, videoId: Y });
    assert.deepEqual(c.opens, [{ videoId: X, live: false }, { videoId: Y, live: true }], 'one open of Y, live');
    assert.equal(watcher.chatVideoId(), Y);
    assert.equal(watcher.chatIsLive(), true);
    w.now += 30_000;
    await watcher.tick();
    assert.equal(c.opens.length, 2, 'no reopen once on Y');
    assert.equal(watcher.getLiveState().raw, 'live');
  } finally {
    global.fetch = real.fetch; console.warn = real.warn; console.log = real.log;
  }
});

// Review M2: an upcoming of ours with no start time is not read — and says so, once per video.
test('an upcoming broadcast with no start time: its countdown chat is not opened, and one line says why', async () => {
  const logs = [];
  const real = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const { c, chat } = stubChat();
  const lookup = async () => ({ state: 'upcoming', videoId: X, certain: false, evidence: 'upcoming', scheduledStart: null });
  const watcher = createYtWatcher({ channelId: CH, chat, lookup, confirm: async () => null, now: () => S });
  try {
    for (let i = 0; i < 3; i++) await watcher.tick();
    assert.equal(c.opens.length, 0);
    assert.equal(logs.filter((l) => l.includes(`${X} has no start time`)).length, 1, logs.join('\n'));
  } finally { console.log = real; }
});

test('retry: a lookup that fails during the countdown reads unknown — never live (a countdown page is not a live chat) — and the countdown resumes', async () => {
  const w = world();
  const { c, chat } = stubChat();
  const watcher = createYtWatcher({ channelId: CH, chat, confirm: async () => null, now: () => w.now });
  try {
    w.now = S - 20 * MIN;
    await watcher.tick();
    assert.equal(c.opens.length, 1);
    w.down = true;
    w.now += 30_000;
    await watcher.tick();
    assert.equal(watcher.getLiveState().raw, 'unknown', 'the chat hold made a countdown read live');
    assert.equal(c.closes, 0, 'a failed lookup does not close the countdown page');
    w.down = false;
    w.now += 30_000;
    await watcher.tick();
    assert.equal(watcher.getLiveState().raw, 'upcoming');
    assert.equal(c.opens.length, 1, 'no reopen');
  } finally { w.restore(); }
});

test('restart: a fresh reader inside the window opens the countdown chat on its first tick; one started after the end opens nothing', async () => {
  const w = world();
  const a = stubChat();
  try {
    w.now = S - 29 * MIN;
    const fresh = createYtWatcher({ channelId: CH, chat: a.chat, confirm: async () => null, now: () => w.now });
    await fresh.tick();
    assert.deepEqual(a.c.opens, [{ videoId: X, live: false }]);
    const b = stubChat();
    w.phase = 'ended';
    w.now = S + 3 * 60 * MIN;
    const late = createYtWatcher({ channelId: CH, chat: b.chat, confirm: async () => null, now: () => w.now });
    await late.tick();
    assert.equal(b.c.opens.length, 0, 'an ended broadcast\'s chat is not opened by a fresh reader');
    assert.equal(late.getLiveState().raw, 'offline');
  } finally { w.restore(); }
});
