// An expired seed token is refreshed BEFORE the first login.
//
// The .env access token lives a few hours; the process restarts far less often. Logging in with
// it as it is gets refused, the journal says "first login failed … stale token" and the
// reconnect's refresh recovers — an error line at every boot that a first-time installer reads as
// a fault. So the seed is checked against Twitch's validate endpoint first: expired (401)
// or about to expire → refresh, then log in once with the fresh token.
//
// Run: node --test platforms/twitchSeedRefresh.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'twitch-seed-refresh-'));
process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.TWITCH_CHANNEL = 'casey';
process.env.TWITCH_BOT_USERNAME = 'caseybot';
process.env.TWITCH_OAUTH_TOKEN = 'expired-seed-token';
process.env.TWITCH_REFRESH_TOKEN = 'casey-refresh-1';
process.env.TWITCH_TOKEN_STATE_PATH = join(dir, 'twitch-token.json');

const { startTwitch } = await import('./twitch.js');
const { seedStillValid } = await import('../lib/twitchToken.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

/** A fake tmi.js that accepts only the fresh token. */
function fakeTmi() {
  const clients = [];
  class Client {
    constructor(config) { this.config = config; clients.push(this); }
    on() {}
    removeListener() {}
    removeAllListeners() {}
    connect() { return this.config.identity?.password === 'oauth:fresh-token' ? Promise.resolve(['irc', 443]) : Promise.reject('Login authentication failed'); }
    disconnect() { return Promise.resolve(); }
    say() { return Promise.resolve(); }
  }
  return { clients, load: async () => ({ Client }) };
}

test('an expired seed: refreshed first, ONE login with the fresh token, and no "first login failed" line', async () => {
  const tmi = fakeTmi();
  const asked = [];
  const realFetch = global.fetch;
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    asked.push(u.replace(/refresh\/.*/, 'refresh/…'));
    if (u === 'https://id.twitch.tv/oauth2/validate') {
      assert.equal(init.headers.Authorization, 'OAuth expired-seed-token');
      return { ok: false, status: 401, json: async () => ({ status: 401, message: 'invalid access token' }) };
    }
    if (/twitchtokengenerator\.com\/api\/refresh\//.test(u)) return { ok: true, status: 200, json: async () => ({ token: 'fresh-token', refresh: 'casey-refresh-2' }) };
    throw new Error(`unexpected ${u}`);
  };
  let handle = null;
  try {
    handle = await startTwitch({ loadTmi: tmi.load });
    assert.deepEqual(asked, ['https://id.twitch.tv/oauth2/validate', 'https://twitchtokengenerator.com/api/refresh/…'], 'validate, then refresh — before any login');
    assert.equal(tmi.clients.length, 1, 'one login, not a refused one and a retry');
    assert.equal(tmi.clients[0].config.identity.password, 'oauth:fresh-token');
    assert.deepEqual(warns.filter((w) => /first login failed/.test(w)), []);
  } finally {
    handle?.stop();
    global.fetch = realFetch;
    console.warn = realWarn;
  }
});

test('seedStillValid: 401 and "under five minutes left" are stale; a good answer, a non-expiring token and an unreachable Twitch are not', async () => {
  const answer = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  assert.equal(await seedStillValid('t', { fetchImpl: answer(401, {}) }), false);
  assert.equal(await seedStillValid('t', { fetchImpl: answer(200, { expires_in: 120 }) }), false);
  assert.equal(await seedStillValid('t', { fetchImpl: answer(200, { expires_in: 9000 }) }), true);
  assert.equal(await seedStillValid('t', { fetchImpl: answer(200, { expires_in: 0 }) }), true, 'expires_in 0 = does not expire');
  assert.equal(await seedStillValid('t', { fetchImpl: async () => { throw new Error('ETIMEDOUT'); } }), true, 'cannot tell = use the seed');
  assert.equal(await seedStillValid('t', { fetchImpl: answer(503, {}) }), true);
});
