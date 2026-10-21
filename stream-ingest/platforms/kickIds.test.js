// Kick without app keys: where the chatroom id comes from, and what is said when it cannot be
// found.
//
// A bundled install cannot "set KICK_CHATROOM_ID in .env" (compose passes the ingest four
// variables and no env file), so the logged workaround must not say so. The override is the settings
// kick.chatroomId + kick.channelId (their env names still work, through the same schema keys), and
// a lookup that fails says exactly that. Live detection without keys says UNKNOWN, once, never
// offline and never a bare "HTTP 403" per tick.
//
// Run: node --test platforms/kickIds.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.KICK_CHANNEL_SLUG = 'casey-test';
for (const k of ['KICK_CLIENT_ID', 'KICK_CLIENT_SECRET', 'KICK_CHATROOM_ID', 'KICK_CHANNEL_ID']) delete process.env[k];

const { resolveIds, fetchKickState, KICK_IDS_HELP } = await import('./kick.js');

const settings = (v) => (k) => v[k] ?? null;
const refuse = (msg) => async () => { throw new Error(msg); };

test('the settings ids win: no lookup at all', async () => {
  let asked = 0;
  const r = await resolveIds('casey-test', {
    get: settings({ 'kick.chatroomId': ' 111 ', 'kick.channelId': '222' }),
    viaApi: async () => { asked += 1; return null; }, viaBrowser: async () => { asked += 1; return null; },
  });
  assert.deepEqual(r, { ids: { chatroomId: '111', channelId: '222' }, error: '' });
  assert.equal(asked, 0);
});

test('a relay never takes the home channel\'s settings ids', async () => {
  const r = await resolveIds('someone-else', {
    allowOverride: false,
    get: settings({ 'kick.chatroomId': '111', 'kick.channelId': '222' }),
    viaApi: async () => ({ chatroomId: '9', channelId: '8' }),
  });
  assert.deepEqual(r.ids, { chatroomId: '9', channelId: '8' });
});

test('both lookups refused: the error names the two settings and where to read them — never ".env"', async () => {
  const realWarn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  let r;
  try {
    r = await resolveIds('casey-test', { get: settings({}), viaApi: refuse('HTTP 403'), viaBrowser: refuse('page answered 403') });
  } finally { console.warn = realWarn; }
  assert.equal(r.ids, null);
  assert.equal(r.error, KICK_IDS_HELP);
  assert.match(r.error, /"Kick chatroom id" and "Kick channel id"/);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /Kick refused the chatroom lookup/, 'the journal says the fix too');
  assert.doesNotMatch(lines.join('\n') + r.error, /\.env/);
});

test('no browser to retry in: said, beside the settings to set', async () => {
  const r = await resolveIds('casey-test', { get: settings({}), viaApi: refuse('HTTP 403'), viaBrowser: refuse('browser missing: Executable doesn\'t exist at /x') });
  assert.match(r.error, /^Kick refused the chatroom lookup .*; no browser to retry in$/);
});

test('keyless live status: kick.com refusing = unknown, said once per episode, with the fix', async () => {
  const realFetch = global.fetch;
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  let answer = 403;
  global.fetch = async () => (answer === 403 ? { ok: false, status: 403, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ livestream: { is_live: false } }) });
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual(await fetchKickState(), { state: 'unknown', viewers: null });
    assert.equal(warns.length, 1, warns.join(' | '));
    assert.match(warns[0], /live status unknown: kick\.com refused the lookup \(HTTP 403\) and no Kick app keys are set/);
    answer = 200;
    assert.equal((await fetchKickState()).state, 'offline');
    answer = 403;
    await fetchKickState();
    assert.equal(warns.length, 2, 'a new episode is said again');
  } finally {
    global.fetch = realFetch;
    console.warn = realWarn;
  }
});
