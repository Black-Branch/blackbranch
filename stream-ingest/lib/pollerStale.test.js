// E10 (ADR 0134): a platform that has not answered for STALE_ANSWER_MS while the night is open is
// said in the journal ONCE per episode — the night stays open while it can't tell, and the admin
// reads why. The rule itself is the vocabulary's (PLATFORM_LIVENESS.staleAnswer); this runs the REAL
// poller against it.
//
// Every test drives startPoller end to end against a mocked fetch on a Twitch-only install (the
// wizard's app pair, no bot token), at the production cadence (60 s live / 180 s idle). Date and
// setTimeout are mocked (node:test MockTimers), so the poller's timers move only when a test steps
// them. A tick is over when no request is in flight and a few event-loop turns pass with no new one.
//
// Run: node --test lib/pollerStale.test.js

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

const HELIX = 'https://api.twitch.tv/helix/streams?user_id=424242';
const T0 = Date.parse('2026-10-24T20:00:00Z');
const MIN = 60_000;
const LINE = '[liveness] twitch has not answered for 15 min — the night stays open while it can\'t tell (helix-error)';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const turn = () => new Promise((r) => setImmediate(r));

let instance = 0;
const freshPoller = async () => import(`./poller.js?stale=${++instance}`);

/** A fake Twitch (token + Helix) and a fake stream-api. `twitch.answer` is 'live' or 'error'. */
function fakeWorld() {
  const w = { twitch: { answer: 'live', reads: 0 }, api: { live: false, streamId: null, starts: [], ends: [] }, requests: 0, inFlight: 0, lines: [] };
  const answer = async (u, init) => {
    const method = init.method || 'GET';
    if (u === 'https://id.twitch.tv/oauth2/token') return json({ access_token: 'app-token', expires_in: 5_000_000, token_type: 'bearer' });
    if (u === HELIX) {
      w.twitch.reads += 1;
      if (w.twitch.answer === 'live') return json({ data: [{ id: '50009', type: 'live', viewer_count: 9 }] });
      return json({ message: 'Internal Server Error' }, 500);
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') return json({ live: w.api.live, streamId: w.api.streamId });
      if (method === 'POST' && path === '/stream/start') { w.api.live = true; w.api.streamId = body.streamId; w.api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/platforms') return json({ ok: true });
      if (method === 'POST' && path === '/viewer-snapshot') return json({ ok: true });
      if (method === 'POST' && path === '/stream/end') { w.api.live = false; w.api.ends.push(body.streamId); return json({ ok: true }); }
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
  w.count = (line) => w.lines.filter((l) => l === line).length;
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
async function minutes(w, n) {
  for (let i = 0; i < n; i++) { mock.timers.tick(MIN); await settle(w); }
}
async function boot(w, now = T0) {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const mod = await freshPoller();
  const poller = mod.startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  await settle(w);
  return { poller, mod };
}

test('Twitch live, then Helix 500 for 16 min: exactly one "has not answered" line, and the night stays open', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await boot(w);
    assert.equal(w.api.starts.length, 1, 'Twitch live opened the night');
    w.twitch.answer = 'error';
    await minutes(w, 14);
    assert.equal(w.count(LINE), 0, 'not before the rule says so');
    await minutes(w, 2);
    assert.equal(w.count(LINE), 1, w.lines.filter((l) => l.startsWith("[liveness]")).join("\n"));
    assert.ok(w.lines.includes("[liveness] twitch live→unknown (helix-error on 50009)"), "Twitch went to can't tell on the first 500");
    // Retry: the episode goes on; nothing more is said.
    await minutes(w, 10);
    assert.equal(w.count(LINE), 1, 'said once per episode');
    assert.equal(w.api.ends.length, 0, 'the night stays open while Twitch can\'t tell');
    assert.ok(w.twitch.reads >= 26, 'the poller kept asking every minute');
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('retry: an answer ends the episode; the next silence is a new episode and is said again', async () => {
  const w = fakeWorld();
  let p;
  try {
    p = await boot(w);
    w.twitch.answer = 'error';
    await minutes(w, 16);
    assert.equal(w.count(LINE), 1);
    w.twitch.answer = 'live';
    await minutes(w, 1);
    w.twitch.answer = 'error';
    await minutes(w, 14);
    assert.equal(w.count(LINE), 1, 'the new episode is not stale yet');
    await minutes(w, 2);
    assert.equal(w.count(LINE), 2, 'a new episode is said again');
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('restart: a fresh process with the night open and Twitch failing from its first read says it once, after the rule', async () => {
  const w = fakeWorld();
  w.api.live = true; w.api.streamId = '1761336000';
  w.twitch.answer = 'error';
  let p;
  try {
    p = await boot(w);
    const st = p.mod.getPlatformStates().twitch;
    assert.equal(st.state, 'unknown');
    assert.equal(st.lastAnswerAt, null, 'never answered in this process');
    await minutes(w, 14);
    assert.equal(w.count(LINE), 0);
    await minutes(w, 2);
    assert.equal(w.count(LINE), 1);
    await minutes(w, 5);
    assert.equal(w.count(LINE), 1);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});

test('no open night: a stale platform is the Doctor\'s to say, not the poller\'s journal', async () => {
  const w = fakeWorld();
  w.twitch.answer = 'error';
  let p;
  try {
    p = await boot(w);
    await minutes(w, 30); // idle cadence (180 s): ten reads
    assert.equal(w.api.starts.length, 0);
    assert.equal(w.lines.filter((l) => l.includes('has not answered')).length, 0);
  } finally { p?.poller.stop(); mock.timers.reset(); w.restore(); }
});
