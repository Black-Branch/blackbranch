// The REAL poller publishes its per-platform states to stream-api (POST /stream/platforms) once per
// tick, as soon as the session is decided (so its nextInMs is the real gap) — so the site's per-platform picture is as fresh as the poller's
// own, and a stream-api that does not know the route yet (an older deploy) costs one log line, never
// a tick.
//
// Every test drives startPoller end to end against a mocked fetch on a Kick-only install, at the
// production cadence (60 s live / 180 s idle). Date and setTimeout are mocked (node:test MockTimers),
// so the poller's own timers move only when a test steps them. A tick is over when no request is in
// flight and a few event-loop turns pass with no new one (settle) — never a wall-clock wait.
// (The nothing-configured `platforms: {}` post is pollerUnconfigured.test.js's: that install has no
// Kick slug in its environment.)
//
// Run: node --test lib/pollerPublish.test.js

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { noteHint } from './liveHints.js';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '60000';
process.env.VIEWER_IDLE_POLL_MS = '180000';
process.env.KICK_CHANNEL_SLUG = 'casey-test';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const KICK_V2 = 'https://kick.com/api/v2/channels/casey-test';
const T0 = Date.parse('2026-10-25T20:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const turn = () => new Promise((r) => setImmediate(r));

let instance = 0;
const freshPoller = async () => import(`./poller.js?instance=${++instance}`);

/** A fake Kick (v2) and a fake stream-api that records every request in order. */
function fakeWorld({ platformsStatus = 200 } = {}) {
  const w = {
    kick: { answer: 'live' },
    api: { live: false, streamId: null, starts: [], ends: [], platforms: [] },
    order: [],
    requests: 0,
    inFlight: 0,
    lines: [],
    platformsStatus,
  };
  const answer = async (u, init) => {
    const method = init.method || 'GET';
    if (u === KICK_V2) {
      w.order.push('kick');
      if (w.kick.answer === 'live') return json({ livestream: { is_live: true, viewer_count: 42 } });
      return json({ livestream: null });
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      w.order.push(`${method} ${path}`);
      if (method === 'POST' && path === '/stream/platforms') {
        w.api.platforms.push(body);
        return w.platformsStatus === 200 ? json({ ok: true }) : new Response('Cannot POST /stream/platforms', { status: w.platformsStatus });
      }
      if (method === 'GET' && path === '/stream/current') {
        if (w.api.currentFails) return new Response('down', { status: 503 });
        return json({ live: w.api.live, streamId: w.api.streamId });
      }
      if (method === 'POST' && path === '/stream/start') { w.api.live = true; w.api.streamId = body.streamId; w.api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') return json({ ok: true });
      if (method === 'POST' && path === '/stream/end') { w.api.live = false; w.api.ends.push(body.streamId); return json({ ok: true }); }
    }
    throw new Error(`unexpected request on a Kick-only install: ${method} ${u}`);
  };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    w.requests += 1;
    w.inFlight += 1;
    try { return await answer(String(url), init); } finally { w.inFlight -= 1; }
  };
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => w.lines.push(a.join(' '));
  console.warn = (...a) => w.lines.push(a.join(' '));
  w.restore = () => { global.fetch = realFetch; console.log = realLog; console.warn = realWarn; };
  return w;
}

async function settle(w) {
  const t0 = performance.now();
  for (;;) {
    if (performance.now() - t0 > 4000) throw new Error('the poller never went quiet');
    if (w.inFlight !== 0) { await turn(); continue; }
    const seen = w.requests;
    for (let i = 0; i < 5; i++) await turn();
    if (w.inFlight === 0 && w.requests === seen) return;
  }
}

async function step(w, ms) {
  mock.timers.tick(ms);
  await settle(w);
}

async function boot(w) {
  noteHint('kick', 'live', 0); // an earlier test's stop hint must not count here
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  await settle(w);
  return { poller, mod };
}

const tickOrder = (w) => w.order.filter((r) => r !== 'POST /viewer-snapshot' && r !== 'POST /stream/start' && r !== 'POST /stream/end');

test('real execution: one POST /stream/platforms per tick, once the session is decided, through two state changes', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w));
    // Tick 1 (startup): Kick live. The session opens on this tick, so the next read is the live delay away.
    assert.equal(w.api.platforms.length, 1);
    const [first] = w.api.platforms;
    assert.equal(first.at, T0);
    assert.equal(first.nextInMs, 60_000);
    assert.deepEqual(Object.keys(first.platforms), ['kick'], 'unconfigured platforms are not sent (null = no vote)');
    assert.equal(first.platforms.kick.state, 'live');
    assert.equal(first.platforms.kick.since, T0);
    assert.deepEqual(w.order, ['kick', 'GET /stream/current', 'POST /stream/start', 'POST /stream/platforms', 'POST /viewer-snapshot'], 'published once the session is decided, before the viewer counts');
    assert.equal(w.api.starts.length, 1, 'the tick carried on to open the session');

    // Tick 2: Kick answers offline — the first answered offline is pending (unknown).
    w.kick.answer = 'offline';
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 2);
    assert.equal(w.api.platforms[1].at, T0 + 60_000);
    assert.equal(w.api.platforms[1].nextInMs, 60_000, 'a session is open: the live cadence');
    assert.equal(w.api.platforms[1].platforms.kick.state, 'unknown');
    assert.equal(w.api.platforms[1].platforms.kick.evidence, 'offline-pending');

    // Tick 3: the second answered offline confirms it.
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 3);
    assert.equal(w.api.platforms[2].platforms.kick.state, 'offline');
    assert.equal(w.api.platforms[2].platforms.kick.since, T0 + 120_000);
    assert.equal(w.api.platforms[2].nextInMs, 180_000, 'every platform confirmed offline: the session closes, so the idle delay — never a delay shorter than the real gap');
    assert.deepEqual(w.api.ends, [w.api.starts[0]], 'and the night still ended on it');
    assert.deepEqual(tickOrder(w), [
      'kick', 'GET /stream/current', 'POST /stream/platforms',
      'kick', 'GET /stream/current', 'POST /stream/platforms',
      'kick', 'GET /stream/current', 'POST /stream/platforms',
    ], 'exactly one publish per tick');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('a wake publishes too, with the delay it reschedules', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w));
    w.kick.answer = 'offline';
    await step(w, 20_000);
    noteHint('kick', 'stop', Date.now());
    await settle(w);
    assert.equal(w.api.platforms.length, 2, 'the woken read published');
    assert.equal(w.api.platforms[1].at, T0 + 20_000);
    assert.equal(w.api.platforms[1].platforms.kick.state, 'offline', 'certain on the stop event');
    // That read closed the session, so the timer restarts at the idle delay — what it sent…
    assert.deepEqual(w.api.ends, [w.api.starts[0]]);
    assert.equal(w.api.platforms[1].nextInMs, 180_000);
    // …and the next publish is exactly that far away.
    await step(w, 179_999);
    assert.equal(w.api.platforms.length, 2);
    await step(w, 1);
    assert.equal(w.api.platforms.length, 3);
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

// The delay a publish sends must be the delay the poller then waits: stream-api judges silence from
// it (clamp(3 × nextInMs, 180 s, 600 s)), so a sent 60 s followed by a real 180 s gap reads every
// platform `unknown` for a few seconds. The case that did it: stream-api closed the session itself
// while no platform was live and one still read "can't tell" (a pending offline).
test('the delay each publish sends is exactly the gap to the next one — the start edge and a session stream-api closed itself', async () => {
  const w = fakeWorld();
  let poller;
  /** The newest publish's nextInMs is the time to the next publish: not one ms sooner, not later. */
  const nextArrivesAsSent = async (label) => {
    const n = w.api.platforms.length;
    const sent = w.api.platforms[n - 1].nextInMs;
    await step(w, sent - 1);
    assert.equal(w.api.platforms.length, n, `${label}: published before the ${sent} ms it sent`);
    await step(w, 1);
    assert.equal(w.api.platforms.length, n + 1, `${label}: no publish at the ${sent} ms it sent`);
    return sent;
  };
  try {
    ({ poller } = await boot(w));
    // Tick 1: Kick live, the session opens on this tick — the live cadence follows.
    assert.equal(w.api.starts.length, 1);
    assert.equal(await nextArrivesAsSent('the start tick'), 60_000);
    // Tick 2 published above. Before tick 3, stream-api closes the session itself and Kick answers
    // offline for the first time (pending = unknown): no platform live, not all confirmed offline.
    w.api.live = false;
    w.kick.answer = 'offline';
    assert.equal(await nextArrivesAsSent('a live tick'), 60_000);
    assert.equal(w.api.platforms.at(-1).platforms.kick.state, 'unknown', 'tick 3 read the pending offline');
    // Tick 3 found no open session: the poller goes idle, and it said so.
    assert.equal(await nextArrivesAsSent('the tick that found the session closed'), 180_000);
    assert.equal(w.api.platforms.at(-1).platforms.kick.state, 'offline');
    assert.equal(await nextArrivesAsSent('an idle tick'), 180_000);
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('a failed session read still publishes, with the delay the poller then keeps', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w));
    w.api.currentFails = true;
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 2, 'the skipped tick published');
    assert.equal(w.api.platforms[1].nextInMs, 60_000, 'a skip keeps the session as it was: open, the live cadence');
    assert.ok(w.lines.some((l) => l.includes('getCurrentStream failed')));
    w.api.currentFails = false;
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 3, 'and the next one came at that delay');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('a stream-api without the route (404) is logged once per process and every tick carries on', async () => {
  const w = fakeWorld({ platformsStatus: 404 });
  let poller;
  try {
    ({ poller } = await boot(w));
    await step(w, 60_000);
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 3, 'still offered every tick (a later deploy adds the route)');
    const notes = w.lines.filter((l) => l.includes('/stream/platforms'));
    assert.equal(notes.length, 1, `one line, not one per tick: ${JSON.stringify(notes)}`);
    assert.match(notes[0], /404/);
    assert.equal(w.api.starts.length, 1, 'the session opened despite the 404');
    assert.equal(w.order.filter((r) => r === 'GET /stream/current').length, 3, 'every tick went on to read the session');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

// Retry: a failed publish (stream-api down for a moment) is not retried inside the tick — the next
// tick's full snapshot replaces it, and the failure never skips the session logic.
test('retry: a publish that fails (5xx) is logged, the tick goes on, and the next tick publishes again', async () => {
  const w = fakeWorld({ platformsStatus: 503 });
  let poller;
  try {
    ({ poller } = await boot(w));
    assert.equal(w.api.starts.length, 1, 'the failed publish did not cost the session read');
    assert.equal(w.lines.filter((l) => l.includes('/stream/platforms')).length, 1);
    w.platformsStatus = 200;
    await step(w, 60_000);
    assert.equal(w.api.platforms.length, 2, 'the next tick published its full snapshot');
    assert.equal(w.api.platforms[1].platforms.kick.state, 'live');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

// Restart: a fresh process (fresh module) publishes on its very first tick, so stream-api's
// silence ends at once and never waits out a window.
test('restart: a fresh poller publishes on its startup tick', async () => {
  for (let i = 0; i < 2; i++) {
    const w = fakeWorld();
    let poller;
    try {
      ({ poller } = await boot(w));
      assert.equal(w.api.platforms.length, 1, `process ${i + 1}: published at startup`);
      assert.equal(w.api.platforms[0].platforms.kick.state, 'live');
    } finally {
      poller?.stop();
      mock.timers.reset();
      w.restore();
    }
  }
});
