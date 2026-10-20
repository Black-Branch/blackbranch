// The Twitch reader keeps its handle when the seed token is stale (external review follow-up).
//
// The first connect is seeded with the .env access token. Once that token has expired, tmi.js
// rejects the first login with the STRING 'Login authentication failed'; the chat client then
// refreshes the token and reconnects by itself. startTwitch() used to reject on that first
// failure, so the platform starter held no handle and the bot's Twitch sender said "no twitch
// sender" until a restart — which hit the same path again. The failed client's own disconnect
// also rejected unhandled ('Cannot disconnect from server…').
//
// A fake tmi.js whose first client refuses the login and whose second accepts it.
//
// Run: node --test platforms/twitchStaleSeed.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'twitch-stale-seed-'));
process.env.STREAM_API_URL = 'http://stream-api.test';
process.env.TWITCH_CHANNEL = 'casey';
process.env.TWITCH_BOT_USERNAME = 'caseybot';
process.env.TWITCH_OAUTH_TOKEN = 'stale-seed-token';
process.env.TWITCH_REFRESH_TOKEN = 'casey-refresh-1';
process.env.TWITCH_TOKEN_STATE_PATH = join(dir, 'twitch-token.json');

const { startTwitch } = await import('./twitch.js');
const { createPlatformStarter } = await import('../lib/platformStarter.js');

/** A fake tmi.js: client #1 refuses the login (and its disconnect rejects, as tmi's does on a
 *  socket that never opened); every later client connects. */
function fakeTmi() {
  const clients = [];
  class Client {
    constructor(config) {
      this.config = config;
      this.n = clients.push(this);
      this.said = [];
      this.listeners = new Map();
    }
    on(ev, fn) { this.listeners.set(ev, fn); }
    removeListener(ev) { this.listeners.delete(ev); }
    removeAllListeners() { this.listeners.clear(); }
    connect() {
      if (this.n === 1) return Promise.reject('Login authentication failed'); // a string, as tmi.js does
      return Promise.resolve(['irc-ws.chat.twitch.tv', 443]);
    }
    disconnect() {
      if (this.n === 1) return Promise.reject('Cannot disconnect from server. Socket is not opened or connection is already closing.');
      return Promise.resolve();
    }
    say(channel, text) { this.said.push({ channel, text }); return Promise.resolve([channel, text]); }
  }
  return { clients, load: async () => ({ Client }) };
}

test('a refused seed token: startTwitch still returns its handle, and replies reach the reconnected client', async () => {
  const tmi = fakeTmi();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(String(url), /twitchtokengenerator\.com\/api\/refresh\//);
    return { ok: true, status: 200, json: async () => ({ token: 'fresh-token', refresh: 'casey-refresh-2' }) };
  };
  let handle = null;
  try {
    handle = await startTwitch({ loadTmi: tmi.load });
    assert.ok(handle, 'the handle is returned even though the first login was refused');
    assert.equal(typeof handle.sendMessage, 'function');
    assert.equal(tmi.clients[0].config.identity.password, 'oauth:stale-seed-token');

    // The chat client's own reconnect (1 s back-off) refreshes the token and logs in.
    const t0 = Date.now();
    while (tmi.clients.length < 2) {
      if (Date.now() - t0 > 5000) throw new Error('the client did not reconnect');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tmi.clients[1].config.identity.password, 'oauth:fresh-token', 'the reconnect used the refreshed token');

    await handle.sendMessage('hello chat');
    assert.deepEqual(tmi.clients[1].said, [{ channel: '#casey', text: 'hello chat' }]);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, [], 'the failed client\'s disconnect must not reject unhandled');
  } finally {
    handle?.stop();
    global.fetch = realFetch;
    process.off('unhandledRejection', onUnhandled);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the anonymous connection is unchanged: a first-connect failure still rejects', async () => {
  // A relay (anonymous, read-only) start: no token, so nothing to refresh — the failure is real.
  const tmi = fakeTmi();
  await assert.rejects(startTwitch({ channel: 'someone', onMessage: () => {}, loadTmi: tmi.load }), (e) => e === 'Login authentication failed');
});

test('the starter prints the reason of a string rejection, not "undefined"', async () => {
  const lines = [];
  const log = { log() {}, warn() {}, error: (...a) => lines.push(a.join(' ')) };
  const platforms = createPlatformStarter({
    starters: { twitch: () => Promise.reject('Login authentication failed') },
    choose: () => ({ enabled: ['twitch'], unknown: [], note: '' }),
    log,
  });
  await platforms.reconcile();
  assert.deepEqual(lines, ['[main] twitch failed to start: Login authentication failed']);
});
