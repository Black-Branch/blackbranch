// Same-broadcast resume (ADR 0134 E8): a stream that dropped and came back within RESUME_GRACE_MS
// on the SAME platform broadcast (its key) reopens the night under the same stream id instead of
// minting a new one. A forced end never resumes; a process restart forgets the last end; stream-api
// refusing the resume (409) falls back to a new id, as before.
//
// The pure parts (nextLiveKeys, resumeCandidate) are tested by table; the rest drives the REAL
// startPoller end to end against a mocked fetch on a Twitch-only install (the wizard's app pair,
// Helix stream id as the key), Date and setTimeout mocked, at the production cadence.
//
// Run: node --test lib/pollerResume.test.js

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '60000';
process.env.VIEWER_IDLE_POLL_MS = '180000';
for (const k of ['TWITCH_OAUTH_TOKEN', 'TWITCH_REFRESH_TOKEN', 'TWITCH_BROADCASTER_ID', 'TWITCH_USER_ID',
  'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET', 'TWITCH_CHANNEL',
  'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';
process.env.TWITCH_BROADCASTER_ID = '424242';
process.env.TWITCH_CLIENT_ID = 'casey-app-client-id';
process.env.TWITCH_CLIENT_SECRET = 'casey-app-client-secret';

const { PLATFORM_LIVENESS } = await import('./platformLiveness.generated.js');
const { RESUME_GRACE_MS } = PLATFORM_LIVENESS;

const HELIX = 'https://api.twitch.tv/helix/streams?user_id=424242';
const T0 = Date.parse('2026-10-24T20:00:00Z');
const MIN = 60_000;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const turn = () => new Promise((r) => setImmediate(r));

let instance = 0;
const freshPoller = async () => import(`./poller.js?resume=${++instance}`);

// ── pure ──

test('nextLiveKeys: live(A) → offline (key "") → unknown keeps A; live(B) replaces it with B', async () => {
  const { nextLiveKeys } = await freshPoller();
  const st = (state, key) => ({ twitch: { state, key }, kick: null, youtube: null, streamplace: null });
  let keys = nextLiveKeys({}, st('live', 'A'));
  assert.deepEqual(keys, { twitch: 'A' });
  keys = nextLiveKeys(keys, st('offline', ''));
  assert.deepEqual(keys, { twitch: 'A' }, 'an answered offline carries no key and never overwrites');
  keys = nextLiveKeys(keys, st('unknown', 'A-stale'));
  assert.deepEqual(keys, { twitch: 'A' }, 'a reading that is not live never overwrites');
  keys = nextLiveKeys(keys, st('live', ''));
  assert.deepEqual(keys, { twitch: 'A' }, 'live with an empty key (Kick\'s v2 fallback) never overwrites');
  keys = nextLiveKeys(keys, st('live', 'B'));
  assert.deepEqual(keys, { twitch: 'B' });
  const prev = { kick: 'K1' };
  nextLiveKeys(prev, st('live', 'C'));
  assert.deepEqual(prev, { kick: 'K1' }, 'a new object: the copy kept at the end is never changed under it');
});

test('resumeCandidate: same key at exactly 5:00 → id; at 5:01 → null; a different key, forced, or no keys → null', async () => {
  const { resumeCandidate } = await freshPoller();
  const at = 1_000_000;
  const ended = (o = {}) => ({ streamId: 'S', lastLiveKeys: { twitch: 'A', kick: 'K' }, at, forced: false, ...o });
  assert.equal(RESUME_GRACE_MS, 5 * MIN);
  assert.equal(resumeCandidate(ended(), { twitch: 'A' }, at + 5 * MIN), 'S', 'exactly 5:00');
  assert.equal(resumeCandidate(ended(), { twitch: 'A' }, at + 5 * MIN + 1_000), null, '5:01');
  assert.equal(resumeCandidate(ended(), { twitch: 'B' }, at + MIN), null, 'a different broadcast');
  assert.equal(resumeCandidate(ended(), { twitch: 'K' }, at + MIN), null, 'a key matches only its OWN platform\'s');
  assert.equal(resumeCandidate(ended(), { twitch: 'B', kick: 'K' }, at + MIN), 'S', 'one platform\'s match is enough');
  assert.equal(resumeCandidate(ended({ forced: true }), { twitch: 'A' }, at + MIN), null, 'forced');
  assert.equal(resumeCandidate(ended(), { twitch: '', kick: '' }, at + MIN), null, 'every current key empty');
  assert.equal(resumeCandidate(ended({ lastLiveKeys: {} }), { twitch: 'A' }, at + MIN), null, 'no key was kept');
  assert.equal(resumeCandidate(ended({ lastLiveKeys: { twitch: '' } }), { twitch: '' }, at + MIN), null, '"" never equals ""');
  assert.equal(resumeCandidate(null, { twitch: 'A' }, at), null, 'no end remembered (a restart)');
});

// ── the real poller ──

/**
 * A fake Twitch (token + Helix) and a fake stream-api that keeps sessions like lifecycle.js:
 * `/stream/start { resume: true }` reopens a row this world ended inside RESUME_GRACE_MS, not a forced
 * one, else 409. `twitch.answer` is 'live' or 'offline'; `twitch.key` the Helix stream id.
 */
function fakeWorld() {
  const w = {
    twitch: { answer: 'live', key: '50009' },
    api: { live: false, streamId: null, starts: [], resumes: [], resumeAsks: [], ends: [], platforms: [], snapshots: [],
      endedAt: new Map(), forcedEndAt: null, forcedId: null, refuseResume: false, failResume: 0 },
    requests: 0, inFlight: 0, lines: [],
  };
  const answer = async (u, init) => {
    const method = init.method || 'GET';
    if (u === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'app-token', expires_in: 5_000_000, token_type: 'bearer' });
    if (u === HELIX) {
      if (w.twitch.answer === 'live') return json({ data: [{ id: w.twitch.key, type: 'live', viewer_count: 9 }] });
      return json({ data: [] });
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      const a = w.api;
      if (method === 'GET' && path === '/stream/current') {
        return json(a.live ? { live: true, streamId: a.streamId } : { live: false, ...(a.forcedEndAt ? { forcedEndAt: a.forcedEndAt } : {}) });
      }
      if (method === 'POST' && path === '/stream/start') {
        if (body.resume === true) {
          a.resumeAsks.push(body.streamId);
          if (a.failResume > 0) { a.failResume -= 1; return new Response('bad gateway', { status: 502 }); }
          const endedAt = a.endedAt.get(body.streamId);
          const ok = !a.refuseResume && endedAt != null && Date.now() - endedAt <= RESUME_GRACE_MS && a.forcedId !== body.streamId;
          if (!ok) return json({ error: 'not resumable' }, 409);
          a.endedAt.delete(body.streamId);
          a.live = true; a.streamId = body.streamId; a.resumes.push(body.streamId); a.forcedEndAt = null;
          return json({ ok: true, resumed: true });
        }
        a.live = true; a.streamId = body.streamId; a.starts.push(body.streamId); a.forcedEndAt = null;
        return json({ ok: true });
      }
      if (method === 'POST' && path === '/stream/platforms') { a.platforms.push(body); return json({ ok: true }); }
      if (method === 'POST' && path === '/viewer-snapshot') { a.snapshots.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/end') {
        a.live = false; a.ends.push(body.streamId); a.endedAt.set(body.streamId, Date.now());
        return json({ ok: true });
      }
    }
    throw new Error(`unexpected request on a Twitch-only install: ${method} ${u}`);
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
  // A mod's "force offline" pressed after the poller's own end: stream-api keeps the hold even
  // though the row is already closed (lifecycle.js /stream/end answers `already`).
  w.forceOffline = (id) => { w.api.forcedEndAt = Date.now(); w.api.forcedId = id; };
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
/**
 * Move the mocked clock forward `ms` in 10 s slices, settling after each, so every timer the poller
 * sets fires at its own time with Date in step — the poller runs on its OWN cadence, no wake.
 */
async function walk(w, ms) {
  for (let done = 0; done < ms; done += 10_000) {
    mock.timers.tick(Math.min(10_000, ms - done));
    await settle(w);
  }
}
async function startOne(w) {
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  await settle(w);
  return { poller, mod };
}
async function boot(w) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
  return startOne(w);
}
/** Twitch live at T0 (session S opens), then two answered offline readings: the poller ends S at T0 + 2 min. */
async function liveThenEnd(w) {
  const p = await boot(w);
  assert.equal(w.api.starts.length, 1, 'Twitch live opened the night');
  w.twitch.answer = 'offline';
  await walk(w, MIN);
  assert.equal(w.api.ends.length, 0, 'one answered offline is not an end');
  await walk(w, MIN);
  assert.deepEqual(w.api.ends, [w.api.starts[0]], 'the second answered offline ended it');
  return p;
}
const streamLines = (w) => w.lines.filter((l) => l.startsWith('[poller] stream')).join('\n');

test('real execution: live(A) → all offline → end → live(A) 2 min later: ONE streamId, reopened with resume: true', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    const S = w.api.starts[0];
    await walk(w, 2 * MIN);
    w.twitch.answer = 'live';
    const posts = w.api.platforms.length;
    await walk(w, MIN);                  // the poller's own next tick, no wake
    assert.deepEqual(w.api.resumeAsks, [S], streamLines(w));
    assert.deepEqual(w.api.resumes, [S]);
    assert.deepEqual(w.api.starts, [S], 'no new id was minted');
    assert.equal(w.api.live, true);
    assert.equal(w.api.streamId, S);
    assert.equal(w.api.snapshots.at(-1), S, 'the heartbeat carries the same id');
    assert.equal(w.api.platforms.length, posts + 1, 'a resume tick publishes like any tick');
    assert.equal(w.api.platforms.at(-1).platforms.twitch.state, 'live');
    assert.equal(w.api.platforms.at(-1).nextInMs, MIN, 'the night is open again: live cadence');
    assert.ok(w.lines.some((l) => l.startsWith(`[poller] stream resumed: ${S}`)), streamLines(w));
    // The resumed night ends like any other.
    w.twitch.answer = 'offline';
    await walk(w, 2 * MIN);
    assert.deepEqual(w.api.ends, [S, S]);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('real execution, NO wake: Twitch back on the same broadcast at end + 4.5 min resumes — the poller keeps the live cadence through the window', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    const S = w.api.starts[0];
    assert.equal(w.api.platforms.at(-1).nextInMs, MIN, 'the end tick says the next read is a minute away, not the idle three');
    const fromEnd = w.api.platforms.length - 1;
    await walk(w, 4.5 * MIN);
    // end, +1, +2, +3 min: a minute each; +4 min: the window's last read lands 5 s before it closes
    // (a tick's own drift cannot push it past the edge).
    assert.deepEqual(w.api.platforms.slice(fromEnd).map((b) => b.nextInMs), [MIN, MIN, MIN, MIN, 55_000]);
    w.twitch.answer = 'live';
    await walk(w, 30_000);               // the window's last read (end + 4:55) sees it
    assert.deepEqual(w.api.resumeAsks, [S], streamLines(w));
    assert.deepEqual(w.api.starts, [S], 'no new id');
    assert.equal(w.api.streamId, S);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('NO wake: back at end + 5.5 min mints a new id, and once the window is over the poller is back on the idle cadence', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    await walk(w, 5.5 * MIN);
    assert.equal(w.api.platforms.at(-1).nextInMs, 180_000, 'window over: idle cadence');
    w.twitch.answer = 'live';
    await walk(w, 3 * MIN);
    assert.deepEqual(w.api.resumeAsks, []);
    assert.equal(w.api.starts.length, 2, 'a new night');
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('a different broadcast (a new Helix id) inside the window mints a new id, without asking to resume', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    await walk(w, 2 * MIN);
    w.twitch.answer = 'live';
    w.twitch.key = '50010';
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, []);
    assert.equal(w.api.starts.length, 2);
    assert.notEqual(w.api.starts[1], w.api.starts[0]);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('a forced end never resumes: a mod\'s press after the poller\'s own end, then the same broadcast back → a new id, and no live cadence for it', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    const S = w.api.starts[0];
    await walk(w, 30_000);
    w.forceOffline(S);
    await walk(w, 30_000);               // the next tick sees forcedEndAt (every platform still offline)
    assert.equal(w.api.platforms.at(-1).nextInMs, 180_000, 'a forced end has no resume window to watch');
    w.twitch.answer = 'live';
    await walk(w, 3 * MIN);
    assert.deepEqual(w.api.resumeAsks, [], 'the poller never asked');
    assert.equal(w.api.starts.length, 2);
    assert.notEqual(w.api.starts[1], S);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('restart: a fresh process forgets the last end — the same broadcast back mints a new id', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    p.poller.stop();
    await walk(w, MIN);
    w.twitch.answer = 'live';
    p = await startOne(w);               // a new module: as after a process restart
    assert.deepEqual(w.api.resumeAsks, []);
    assert.equal(w.api.starts.length, 2);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('retry: stream-api refusing the resume (409) falls back to a new id on the same tick', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    const S = w.api.starts[0];
    await walk(w, 2 * MIN);
    w.api.refuseResume = true;
    w.twitch.answer = 'live';
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, [S]);
    assert.equal(w.api.starts.length, 2, 'minted a new id');
    assert.equal(w.api.live, true);
    assert.equal(w.api.streamId, w.api.starts[1]);
    assert.equal(w.api.snapshots.at(-1), w.api.starts[1]);
    // The new night is closed by someone else (stream-api's heartbeat self-heal) while Twitch is
    // still live: the next tick starts again — and never asks about S, whose end was spent.
    w.api.live = false;
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, [S], 'the refused end is not asked about again');
    assert.equal(w.api.starts.length, 3);
    // The next drop and return resumes the night's OWN id.
    w.api.refuseResume = false;
    w.twitch.answer = 'offline';
    await walk(w, 2 * MIN);
    w.twitch.answer = 'live';
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, [S, w.api.starts[2]], 'the next night resumes its OWN id');
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('retry: stream-api failing the resume (502) mints nothing on that tick; the next tick resumes', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await liveThenEnd(w);
    const S = w.api.starts[0];
    await walk(w, 2 * MIN);
    w.api.failResume = 1;
    w.twitch.answer = 'live';
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, [S]);
    assert.equal(w.api.starts.length, 1, 'could not ask is not "refused": no new id');
    assert.equal(w.api.live, false);
    await walk(w, MIN);
    assert.deepEqual(w.api.resumeAsks, [S, S]);
    assert.deepEqual(w.api.resumes, [S]);
    assert.deepEqual(w.api.starts, [S]);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});
