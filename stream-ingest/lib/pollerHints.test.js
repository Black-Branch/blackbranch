// Push hints wake the REAL poller (ADR 0134 E7/E11, plan ruling 6): Kick's realtime stop event
// triggers an immediate read, and that read's "not live" counts at once. The event alone never ends
// anything: while Kick's API still says live, Kick stays live.
//
// Every test drives startPoller end to end against a mocked fetch on a Kick-only install, at the
// production cadence (60 s live / 180 s idle). Date and setTimeout are mocked (node:test MockTimers),
// so the poller's own timers move only when a test steps them: a read the test did not step a timer
// for was a wake. A tick is over when no request is in flight and a few event-loop turns pass with no
// new one (settle) — never a wall-clock wait.
//
// Run: node --test lib/pollerHints.test.js

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
const T0 = Date.parse('2026-10-24T08:37:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// setImmediate is not mocked: one turn of the event loop, after every pending microtask.
const turn = () => new Promise((r) => setImmediate(r));
const until = async (pred, what, ms = 4000) => {
  const t0 = performance.now();
  while (!pred()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await turn();
  }
};

// A fresh poller module per test: its states start empty, as after a process start. liveHints is
// one shared module (the poller imports it plainly), as in production.
let instance = 0;
const freshPoller = async () => import(`./poller.js?instance=${++instance}`);

/**
 * A fake Kick (v2: no app keys on this install) and a fake stream-api. `kick.answer` is 'live',
 * 'offline', 'error', or a promise the read waits on (to hold a tick open).
 */
function fakeWorld() {
  const w = {
    kick: { answer: 'live', reads: 0, inFlight: 0, maxInFlight: 0 },
    api: { live: false, streamId: null, starts: [], ends: [] },
    requests: 0,
    inFlight: 0,
    lines: [],
  };
  const answer = async (u, init) => {
    const method = init.method || 'GET';
    if (u === KICK_V2) {
      w.kick.reads += 1;
      w.kick.inFlight += 1;
      w.kick.maxInFlight = Math.max(w.kick.maxInFlight, w.kick.inFlight);
      try {
        let a = w.kick.answer;
        if (typeof a?.then === 'function') a = await a;
        if (a === 'live') return json({ livestream: { is_live: true, viewer_count: 42 } });
        if (a === 'offline') return json({ livestream: null });
        return new Response('down', { status: 503 });
      } finally {
        w.kick.inFlight -= 1;
      }
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') return json({ live: w.api.live, streamId: w.api.streamId });
      if (method === 'POST' && path === '/stream/start') { w.api.live = true; w.api.streamId = body.streamId; w.api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/platforms') return json({ ok: true }); // the per-tick publish (pollerPublish.test.js)
      if (method === 'POST' && path === '/viewer-snapshot') return json({ ok: true });
      if (method === 'POST' && path === '/stream/end') { w.api.live = false; w.api.ends.push({ streamId: body.streamId, kickReads: w.kick.reads }); return json({ ok: true }); }
    }
    throw new Error(`unexpected request on a Kick-only install: ${method} ${u}`);
  };
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    w.requests += 1;
    w.inFlight += 1;
    try {
      return await answer(String(url), init);
    } finally {
      w.inFlight -= 1;
    }
  };
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => w.lines.push(a.join(' '));
  console.warn = (...a) => w.lines.push(a.join(' '));
  w.has = (line) => w.lines.includes(line);
  w.restore = () => { global.fetch = realFetch; console.log = realLog; console.warn = realWarn; };
  return w;
}

/**
 * Wait until the poller is quiet: nothing in flight, and five event-loop turns with no new request.
 * A tick's steps between two requests are microtasks, so a tick still under way always issues its
 * next request inside one turn. Fails, never passes, if the poller never goes quiet.
 */
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

/** Step the mocked clock and timers by `ms`, then wait for whatever that started to finish. */
async function step(w, ms) {
  mock.timers.tick(ms);
  await settle(w);
}

/** Start a fresh poller at T0 with the clock mocked; wait for its startup tick to finish. */
async function boot(w) {
  // An earlier test's stop hint must not count here; a live hint is never evidence of an end.
  noteHint('kick', 'live', 0);
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  await settle(w);
  assert.equal(w.kick.reads, 1, 'the startup tick read Kick once');
  return { poller, mod };
}

/** A hint, then wait for the read it may have started to finish. */
async function hint(w, kind, at) {
  noteHint('kick', kind, at);
  await settle(w);
}

const kickLine = (w) => w.lines.filter((l) => l.startsWith('[liveness] kick '));


test('kickStopCertain: only an answered offline with a stop hint at most 180 s old is certain', async () => {
  const { kickStopCertain } = await import('./poller.js');
  const NOW = 1_000_000;
  const stop = (ago) => ({ kind: 'stop', at: NOW - ago });
  const rows = [
    ['offline', stop(5_000), true, 'a stop 5 s before the read'],
    ['offline', stop(180_000), true, 'exactly 180 s'],
    ['offline', stop(180_001), false, '1 ms past the window'],
    ['offline', stop(-2_000), true, 'a stop that arrived during the read'],
    ['offline', { kind: 'live', at: NOW - 5_000 }, false, 'a live hint'],
    ['offline', null, false, 'no hint'],
    ['live', stop(5_000), false, 'the API still says live'],
    ['unknown', stop(5_000), false, 'Kick could not be asked'],
    [null, stop(5_000), false, 'Kick not configured'],
  ];
  for (const [raw, hint, want, why] of rows) assert.equal(kickStopCertain(raw, hint, NOW), want, why);
});

test('real execution: Kick live, then its stop event — the woken read answers not live and /stream/end posts on that wake, with no second reading and no 60 s timer', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w));
    assert.equal(w.api.starts.length, 1, 'the startup tick opened the session');
    w.kick.answer = 'offline';
    await step(w, 30_000); // the 60 s timer is still 30 s away
    assert.equal(w.kick.reads, 1);
    await hint(w, 'stop');
    assert.equal(w.kick.reads, 2, 'one read at start, one on the wake: the stop needed no second reading');
    assert.deepEqual(w.api.ends, [{ streamId: w.api.starts[0], kickReads: 2 }]);
    assert.ok(w.has('[poller] kick stop hint — reading now'));
    assert.deepEqual(kickLine(w), ['[liveness] kick none→live (kick-live)', '[liveness] kick live→offline (stop-event)']);
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(a) a stop hint, then the API answering is_live:false: offline, certain, evidence stop-event', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    w.kick.answer = 'offline';
    await step(w, 11_000);
    await hint(w, 'stop');
    const k = mod.getPlatformStates().kick;
    assert.equal(k.state, 'offline');
    assert.equal(k.evidence, 'stop-event');
    assert.equal(k.misses, 1, 'confirmed on its first answered offline');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(b) a stop hint while the API still says is_live:true: Kick stays live; one follow-up read 30 s later, and its not-live counts at once', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    await step(w, 11_000);
    await hint(w, 'stop');
    assert.equal(w.kick.reads, 2);
    assert.equal(mod.getPlatformStates().kick.state, 'live', 'the event alone never ends anything');
    assert.equal(mod.getPlatformStates().kick.evidence, 'kick-live');
    assert.equal(w.api.ends.length, 0);
    assert.ok(w.has('[poller] platform states: twitch=unconfigured kick=live youtube=unconfigured streamplace=unconfigured'));

    w.kick.answer = 'offline'; // the API catches up
    await step(w, 29_999);
    assert.equal(w.kick.reads, 2, 'nothing before the follow-up is due');
    await step(w, 1);
    assert.equal(w.kick.reads, 3, 'the follow-up, 30 s after the stop\'s own read');
    assert.ok(w.has('[poller] kick stop recheck — reading now'));
    assert.equal(w.api.ends.length, 1, 'the end once the API agrees');
    assert.equal(mod.getPlatformStates().kick.evidence, 'stop-event');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(b) the follow-up is ONE: still live on it, the next read is the regular 60 s one', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    await step(w, 11_000);
    await hint(w, 'stop');
    await step(w, 30_000);
    assert.equal(w.kick.reads, 3, 'the follow-up');
    assert.equal(mod.getPlatformStates().kick.state, 'live');
    await step(w, 59_999);
    assert.equal(w.kick.reads, 3, 'no second follow-up');
    w.kick.answer = 'offline';
    await step(w, 1);
    assert.equal(w.kick.reads, 4, 'the regular read, 60 s after the follow-up');
    assert.equal(w.api.ends.length, 1, 'still inside the 180 s window: certain');
    assert.equal(mod.getPlatformStates().kick.evidence, 'stop-event');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(b) a recent LIVE hint is no evidence of an end: an offline answer after it needs its second reading, and gets no follow-up', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    w.kick.answer = 'offline';
    await step(w, 11_000);
    await hint(w, 'live');
    assert.equal(w.kick.reads, 2);
    assert.equal(mod.getPlatformStates().kick.state, 'unknown');
    assert.equal(mod.getPlatformStates().kick.evidence, 'offline-pending');
    assert.equal(w.api.ends.length, 0);
    await step(w, 59_999);
    assert.equal(w.kick.reads, 2, 'no follow-up read for a live hint');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(c) a stop hint older than 180 s is not evidence: the offline needs its second reading', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    w.kick.answer = 'offline';
    await step(w, 11_000);
    await hint(w, 'stop', Date.now() - 180_001);
    assert.equal(w.kick.reads, 2);
    const k = mod.getPlatformStates().kick;
    assert.equal(k.state, 'unknown');
    assert.equal(k.evidence, 'offline-pending');
    assert.equal(w.api.ends.length, 0, 'not ended on one uncertain reading');
    assert.ok(w.lines.some((l) => l.includes('kick=offline(1/2)')));
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(c) boundary: a stop hint exactly 180 s before the read still counts', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    w.kick.answer = 'offline';
    await step(w, 11_000);
    // The clock is mocked, so the woken tick reads at the instant the hint is stamped against.
    await hint(w, 'stop', Date.now() - 180_000);
    assert.equal(w.api.ends.length, 1);
    assert.equal(mod.getPlatformStates().kick.evidence, 'stop-event');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(d) hints inside the 10 s gap: one deferred read at the gap\'s end, more hints add none — never more than one read per 10 s', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w)); // the startup read began at T0
    await step(w, 11_000);
    await hint(w, 'stop'); // T0+11: past the gap, reads now
    assert.equal(w.kick.reads, 2);
    await step(w, 3_000);
    assert.equal(poller.wake('test'), 'gap', 'refused for the gap itself (the woken read is over)');
    assert.ok(w.has('[poller] test — a read began 3s ago; reading at the gap\'s end'));
    await hint(w, 'live'); // T0+14
    await step(w, 2_000);
    await hint(w, 'live'); // T0+16
    assert.equal(w.kick.reads, 2, 'nothing read inside the gap');
    assert.equal(w.lines.filter((l) => l.includes('reading at the gap\'s end')).length, 1, 'one deferred read armed, not three');
    await step(w, 4_999);
    assert.equal(w.kick.reads, 2, 'not before the gap\'s end');
    await step(w, 1); // T0+21: 10 s after the woken read began
    assert.equal(w.kick.reads, 3, 'the one deferred read');
    assert.ok(w.has('[poller] test — reading now (the gap is over)'));
    await step(w, 9_999);
    assert.equal(w.kick.reads, 3, 'and nothing else inside the next 10 s');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(d) a start hint inside the gap of an idle poller opens the session at the gap\'s end, not 180 s later', async () => {
  const w = fakeWorld();
  w.kick.answer = 'offline';
  let poller;
  try {
    ({ poller } = await boot(w));
    w.kick.answer = 'live';
    await step(w, 4_000);
    await hint(w, 'live');
    assert.equal(w.api.starts.length, 0);
    await step(w, 6_000);
    assert.equal(w.kick.reads, 2);
    assert.equal(w.api.starts.length, 1, 'opened 10 s after the startup read');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('multistream end: stream.place\'s stop wakes a read while Kick is still live; Kick\'s stop 3 s later is read at the gap\'s end and ends the night', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    await step(w, 20_000);
    noteHint('streamplace', 'stop');
    await settle(w);
    assert.equal(w.kick.reads, 2, 'stream.place\'s hint read everything, Kick still live');
    assert.equal(mod.getPlatformStates().kick.state, 'live');
    w.kick.answer = 'offline';
    await step(w, 3_000);
    await hint(w, 'stop');
    assert.equal(w.kick.reads, 2);
    await step(w, 7_000);
    assert.equal(w.kick.reads, 3, 'Kick\'s stop, read at the gap\'s end');
    assert.equal(w.api.ends.length, 1, 'the night ends 10 s after the first stop, not on the 60 s timer');
    assert.equal(mod.getPlatformStates().kick.evidence, 'stop-event');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('a tick that begins after the hint is its read: the deferred read is dropped', async () => {
  const w = fakeWorld();
  const saved = process.env.VIEWER_POLL_MS;
  process.env.VIEWER_POLL_MS = '4000'; // read at import: regular ticks at T0+4, +8, +12 — inside the gap
  let poller;
  try {
    ({ poller } = await boot(w));
    process.env.VIEWER_POLL_MS = saved;
    w.kick.answer = 'live';
    await step(w, 2_000);
    await hint(w, 'stop'); // T0+2: deferred to T0+10
    assert.ok(w.has('[poller] kick stop hint — a read began 2s ago; reading at the gap\'s end'));
    await step(w, 2_000); // T0+4: a regular tick begins — it is the hint's read
    assert.equal(w.kick.reads, 2);
    await step(w, 4_000); // T0+8
    assert.equal(w.kick.reads, 3);
    await step(w, 3_000); // T0+11: past the deferred read's due time
    assert.equal(w.kick.reads, 3, 'no deferred read at T0+10');
    assert.ok(!w.lines.some((l) => l.includes('(the gap is over)')));
  } finally {
    process.env.VIEWER_POLL_MS = saved;
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(e) a wake during a tick starts no concurrent tick; its read comes once, after that tick, at the gap\'s end — or when the tick ends, if it runs past it', async () => {
  const w = fakeWorld();
  let release;
  w.kick.answer = new Promise((r) => { release = () => r('live'); });
  noteHint('kick', 'live', 0);
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  try {
    await until(() => w.kick.inFlight === 1, 'the startup tick reading Kick');
    mock.timers.tick(2_000);
    assert.equal(poller.wake('test'), 'running', 'refused while a tick runs');
    assert.ok(w.has('[poller] test — a read is running; reading again once the gap is over'));
    noteHint('kick', 'stop');
    await turn();
    assert.equal(w.kick.reads, 1);
    mock.timers.tick(8_000); // T0+10: due, but the startup tick still runs
    await turn();
    assert.equal(w.kick.reads, 1, 'still one: the read waits for the running tick');
    release();
    await settle(w);
    assert.equal(w.kick.reads, 2, 'read once, right after the running tick');
    assert.ok(w.has('[poller] test — reading now (after the running read)'));
    assert.equal(w.kick.maxInFlight, 1, 'never two Kick reads at once');
  } finally {
    poller.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(e) a wake during a short tick reads at the gap\'s end, after the tick is over', async () => {
  const w = fakeWorld();
  let release;
  w.kick.answer = new Promise((r) => { release = () => r('live'); });
  noteHint('kick', 'live', 0);
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  try {
    await until(() => w.kick.inFlight === 1, 'the startup tick reading Kick');
    assert.equal(poller.wake('test'), 'running');
    release();
    await settle(w);
    assert.equal(w.kick.reads, 1);
    await step(w, 9_999);
    assert.equal(w.kick.reads, 1);
    await step(w, 1);
    assert.equal(w.kick.reads, 2, 'at the gap\'s end');
    assert.equal(w.kick.maxInFlight, 1);
  } finally {
    poller.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('the follow-up counts from the stop\'s OWN read: a stop during a running tick is followed up 30 s after its deferred read', async () => {
  const w = fakeWorld();
  let release;
  w.kick.answer = new Promise((r) => { release = () => r('live'); });
  noteHint('kick', 'live', 0);
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  try {
    await until(() => w.kick.inFlight === 1, 'the startup tick reading Kick');
    mock.timers.tick(2_000);
    noteHint('kick', 'stop'); // T0+2, during the startup tick (whose Kick read began before it)
    w.kick.answer = 'live';
    release();
    await settle(w);
    assert.equal(w.kick.reads, 1);
    await step(w, 8_000); // T0+10: the stop's own read, deferred to the gap's end
    assert.equal(w.kick.reads, 2);
    assert.equal(mod.getPlatformStates().kick.state, 'live');
    await step(w, 29_999);
    assert.equal(w.kick.reads, 2, 'no follow-up counted from the startup read');
    await step(w, 1); // T0+40
    assert.equal(w.kick.reads, 3, 'the follow-up, 30 s after the stop\'s own read');
  } finally {
    poller.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('(f) after stop(), a hint does not tick, wake() refuses, and a pending deferred read or follow-up is dropped', async () => {
  const w = fakeWorld();
  let poller;
  try {
    ({ poller } = await boot(w));
    await step(w, 11_000);
    await hint(w, 'stop'); // still live: a follow-up is armed for +30 s
    await step(w, 3_000);
    await hint(w, 'live'); // inside the gap: a deferred read is armed for +7 s
    assert.equal(w.kick.reads, 2);
    poller.stop();
    await hint(w, 'stop');
    assert.equal(poller.wake('test'), 'stopped');
    await step(w, 600_000);
    assert.equal(w.kick.reads, 2, 'nothing read after stop: no hint, deferred read, follow-up or timer');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('restart: a stopped poller and its successor — a hint reads once, on the running one, and the new one starts with no state', async () => {
  const w = fakeWorld();
  let first;
  let second;
  try {
    ({ poller: first } = await boot(w));
    first.stop();
    mock.timers.reset();
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 + 180_000 });
    const mod = await freshPoller();
    second = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
    await settle(w);
    assert.equal(w.kick.reads, 2, 'the successor\'s startup read');
    assert.equal(w.lines.filter((l) => l === '[liveness] kick none→live (kick-live)').length, 2, 'the successor began from no state');
    await step(w, 11_000);
    await hint(w, 'live');
    assert.equal(w.kick.reads, 3, 'one read on the hint: the stopped poller no longer listens');
    assert.equal(mod.getPlatformStates().kick.state, 'live');
  } finally {
    first?.stop();
    second?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('retry: the woken read fails (Kick could not be asked); the next read inside the window that answers not live still counts at once', async () => {
  const w = fakeWorld();
  let poller;
  let mod;
  try {
    ({ poller, mod } = await boot(w));
    w.kick.answer = 'error';
    await step(w, 11_000);
    await hint(w, 'stop');
    assert.equal(mod.getPlatformStates().kick.state, 'unknown');
    assert.equal(mod.getPlatformStates().kick.evidence, 'kick-error');
    assert.equal(w.api.ends.length, 0, 'a failed read ends nothing');

    w.kick.answer = 'offline';
    await step(w, 59_999);
    assert.equal(w.kick.reads, 2, 'no follow-up after a failed read: the regular read retries');
    await step(w, 1); // the regular read, 60 s after the woken one: the hint is 60 s old
    assert.equal(w.kick.reads, 3);
    assert.equal(w.api.ends.length, 1, 'the end on the answered read');
    assert.equal(mod.getPlatformStates().kick.evidence, 'stop-event');
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});

test('a live hint wakes an idle poller: the session opens on the woken read, not 180 s later', async () => {
  const w = fakeWorld();
  w.kick.answer = 'offline';
  let poller;
  try {
    ({ poller } = await boot(w));
    assert.equal(w.api.starts.length, 0);
    w.kick.answer = 'live';
    await step(w, 30_000);
    await hint(w, 'live');
    assert.equal(w.api.starts.length, 1, 'the start, on the wake');
    assert.equal(w.kick.reads, 2);
    assert.ok(w.has('[poller] kick live hint — reading now'));
  } finally {
    poller?.stop();
    mock.timers.reset();
    w.restore();
  }
});
