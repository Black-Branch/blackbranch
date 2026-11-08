// The REAL poller, end to end, on the per-platform state model: Twitch live, then Helix answers
// "not streaming" twice. Kick is not configured and no YouTube or stream.place reader runs.
//
// What a reader of the journal must be able to see: the first answered offline is printed as
// `offline(1/2)` (an answer still waiting for its confirmation), not as `unknown` (which, before
// this, also meant "Twitch could not be asked": research §C4); each state change prints one
// `[liveness]` line; the session ends on the second answered offline, not before.
//
// Run: node --test lib/pollerStates.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.VIEWER_POLL_MS = '5';
process.env.VIEWER_IDLE_POLL_MS = '5';
for (const k of ['TWITCH_REFRESH_TOKEN', 'TWITCH_USER_ID', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET',
  'TWITCH_OAUTH_CLIENT_ID', 'TWITCH_OAUTH_CLIENT_SECRET', 'YOUTUBE_API_KEY', 'YOUTUBE_CHANNEL_ID', 'YOUTUBE_VIDEO_ID',
  'KICK_CHANNEL_SLUG', 'KICK_CHANNEL', 'KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'YT_INNERTUBE_VIEWERS']) delete process.env[k];
process.env.TWITCH_OAUTH_TOKEN = 'test-access-token';
process.env.TWITCH_BROADCASTER_ID = '555123456';
process.env.TWITCH_TOKEN_STATE_PATH = '/nonexistent/twitch-token.json';

const { startPoller, getPlatformStates } = await import('./poller.js');

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const until = async (pred, what, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
};

test('Twitch live → empty ×2: offline(1/2) is printed, one live→unknown then one →offline, and the end posts on the second empty answer', async () => {
  const api = { live: false, streamId: null, starts: [], ends: [] };
  let helix = 'live';
  let emptyAnswers = 0;
  let endedAfter = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('id.twitch.tv/oauth2/validate')) return json({ client_id: 'test-client-id' });
    if (u.startsWith('https://api.twitch.tv/helix/streams?user_id=555123456')) {
      if (helix === 'live') return json({ data: [{ id: '40001', type: 'live', viewer_count: 12 }] });
      emptyAnswers += 1;
      return json({ data: [] });
    }
    if (u.startsWith('http://stream-api.test/')) {
      const path = u.slice('http://stream-api.test'.length);
      const body = init.body ? JSON.parse(init.body) : null;
      if (method === 'GET' && path === '/stream/current') return json({ live: api.live, streamId: api.streamId });
      if (method === 'POST' && path === '/stream/start') { api.live = true; api.streamId = body.streamId; api.starts.push(body.streamId); return json({ ok: true }); }
      if (method === 'POST' && path === '/stream/platforms') return json({ ok: true }); // the per-tick publish (pollerPublish.test.js)
      if (method === 'POST' && path === '/viewer-snapshot') return json({ ok: true });
      if (method === 'POST' && path === '/stream/end') { api.live = false; api.ends.push(body.streamId); endedAfter = emptyAnswers; return json({ ok: true }); }
    }
    throw new Error(`unexpected request: ${method} ${u}`);
  };
  const lines = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  const poller = startPoller({ getStreamplaceViewers: () => null, ytWanted: () => false });
  try {
    await until(() => api.starts.length === 1 && lines.filter((l) => l.includes('twitch=live')).length >= 2, 'a session while Twitch is live');
    assert.equal(getPlatformStates().twitch.state, 'live');
    assert.equal(getPlatformStates().twitch.key, '40001', 'the Helix stream id is the key');
    assert.equal(getPlatformStates().kick, null, 'Kick is not configured');

    helix = 'empty';
    await until(() => api.ends.length === 1, 'the session to end');
    assert.equal(endedAfter, 2, 'one empty answer is pending; the second ends the session');
    assert.deepEqual(api.ends, api.starts);
    await until(() => emptyAnswers >= 4, 'more ticks after the end');
  } finally {
    poller.stop();
    global.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
  }
  const states = lines.filter((l) => l.startsWith('[poller] platform states: '));
  assert.ok(states.length >= 4);
  for (const l of states) {
    assert.match(l, /^\[poller\] platform states: twitch=(live|offline\(1\/2\)|offline) kick=unconfigured youtube=unconfigured streamplace=unconfigured$/, l);
  }
  assert.ok(states.some((l) => l.includes('twitch=offline(1/2)')), 'the pending answer is printed as one offline of two');
  const transitions = lines.filter((l) => l.startsWith('[liveness] twitch '));
  assert.deepEqual(transitions, [
    '[liveness] twitch none→live (helix-live on 40001)',
    '[liveness] twitch live→unknown (offline-pending on 40001)',
    // An answered offline carries no key (Helix's empty answer names no stream), and the state
    // copies the answer's key, so the confirmation line has none.
    '[liveness] twitch unknown→offline (helix-empty)',
  ]);
  assert.equal(lines.filter((l) => l.startsWith('[liveness] ')).length, 3, 'unconfigured platforms print no transition');
  assert.equal(getPlatformStates().twitch.state, 'offline');
});

test('getPlatformStates returns a copy: a caller cannot change the poller\'s states', () => {
  const s = getPlatformStates();
  s.twitch = null;
  assert.notEqual(getPlatformStates().twitch, null);
});

// Replaces pollerMissCounter.test.js's scan (`ytOffline = createMissCounter`): every platform goes
// through the one state model. Positive assertions plus negative ones, so the file ends on its
// vacuity anchor — the scanned text must still hold poller.js's LAST function.
test('tick passes each of PLATFORMS through platformState, and no per-platform counter is left', () => {
  const src = readFileSync(new URL('./poller.js', import.meta.url), 'utf8');
  const tick = src.slice(src.indexOf('async function tick('), src.indexOf('export function startPoller('));
  assert.ok(tick.length > 500, 'tick was found');
  assert.match(tick, /for \(const name of PLATFORMS\) \{[^}]*platformState\(states\[name\], obs\[name\], tickAt\)/);
  assert.match(tick, /aggregateLiveness\(PLATFORMS\.map\(\(name\) => \(\{ name, state: voteOf\(states\[name\]\) \}\)\)\)/);
  assert.match(tick, /console\.log\(formatStatesLine\(states\)\)/);
  assert.doesNotMatch(src, /createMissCounter|twOffline|kickOffline|ytOffline|spOffline/, 'the old counters are gone');
  assert.doesNotMatch(src, /100 units per call/, 'search.list is 1 unit in a 100-call/day bucket');
  // Vacuity anchor: the scan reached the end of poller.js — startPoller is its last export, and
  // the text runs on to that function's closing brace at the end of the file.
  const last = src.lastIndexOf('export function startPoller(');
  assert.ok(last !== -1, 'startPoller was found');
  const tail = src.slice(last);
  assert.doesNotMatch(tail.slice(1), /\nexport /, 'nothing is exported after startPoller');
  assert.match(tail, /\n {2}return \{\n[\s\S]*\n {4}wake,\n {2}\};\n\}\n?$/, 'the file ends on startPoller\'s returned handle');
});
