// The readers follow the settings on EVERY load, not only the first.
//
// An install's channels are saved in the Admin Panel after setup. A starter that chose the
// platforms only at boot and on the first settings load would leave a platform added later
// reading nothing until a restart, and one switched off still reading. Here a real settings
// reader is loaded again and again while the stored channels change; the starters are spies.
//
// Run: node --test lib/platformReconcile.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { createInstanceConfig } from './instanceConfig.js';
import { choosePlatforms } from './platformsEnv.js';
import { createPlatformStarter, startPlatformsWhenLoaded, oneLine } from './platformStarter.js';

process.env.STREAM_API_URL = 'http://stream-api.test';

const quiet = { log() {}, warn() {}, error() {} };
const json = (body) => ({ ok: true, status: 200, json: async () => body });
class NoSocket { on() {} close() {} }

/** A settings reader over a mutable stored layer. */
function reader(stored = {}) {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/config')) return json({ values: { ...stored } });
    if (u.includes('/config/secrets')) return json({ values: {}, unreadable: [] });
    if (u.endsWith('/content')) return json({ content: {} });
    return json({});
  };
  const config = createInstanceConfig({ env: { STREAM_API_URL: 'http://stream-api.test' }, fetchImpl, WebSocketImpl: NoSocket, log: quiet });
  return { config, stored };
}

function spies() {
  const log = [];
  const running = {};
  const starters = Object.fromEntries(['twitch', 'kick', 'youtube', 'streamplace'].map((name) => [name, async () => {
    log.push(`start ${name}`);
    running[name] = (running[name] || 0) + 1;
    return { stop() { log.push(`stop ${name}`); running[name] -= 1; } };
  }]));
  return { log, running, starters };
}

const starterFor = (config, starters, extra = {}) => createPlatformStarter({
  starters,
  choose: () => choosePlatforms(undefined, Object.keys(starters), (k) => config.get(k)),
  log: quiet,
  ...extra,
});

test('a platform switched on after boot starts on the next load; switched off, it stops; on again, it starts', async () => {
  const { config, stored } = reader({});
  const { log, running, starters } = spies();
  try {
    const bootLoaded = await config.start();
    const platforms = starterFor(config, starters);
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded, log: quiet });
    assert.deepEqual(log, [], 'a fresh install reads nothing');
    assert.equal(platforms.states().streamplace.state, 'off');

    stored['platform.streamplace.did'] = 'did:plc:caseytest';
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start streamplace'], 'saving the channel was enough — no restart');
    assert.equal(platforms.states().streamplace.state, 'running');

    delete stored['platform.streamplace.did'];
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start streamplace', 'stop streamplace']);
    assert.equal(running.streamplace, 0);
    assert.equal(platforms.handle('streamplace'), null);
    assert.equal(platforms.states().streamplace.state, 'off');

    // Retry: the same switch again works the same way.
    stored['platform.streamplace.did'] = 'did:plc:caseytest';
    await config.load();
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start streamplace', 'stop streamplace', 'start streamplace'], 'on again starts it once, however many loads follow');
  } finally { config.stop(); }
});

test('a channel changed while its reader runs: the reader is stopped, then started with the new one', async () => {
  const { config, stored } = reader({ 'platform.twitch.channel': 'casey' });
  const { log, running, starters } = spies();
  const applied = [];
  try {
    const platforms = starterFor(config, starters, { onApplied: (name) => applied.push(name) });
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded: await config.start(), log: quiet });
    stored['platform.twitch.channel'] = 'casey2';
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start twitch', 'stop twitch', 'start twitch']);
    assert.equal(running.twitch, 1, 'never two readers of one platform');
    assert.deepEqual(applied, ['twitch', 'twitch'], 'each start counts its settings as applied');
  } finally { config.stop(); }
});

test('YouTube follows its module switch live', async () => {
  const { config, stored } = reader({ 'platform.youtube.channelId': 'UCcaseytest', 'modules.youtube': false });
  const { log, starters } = spies();
  try {
    const platforms = starterFor(config, starters);
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded: await config.start(), log: quiet });
    assert.deepEqual(log, []);
    stored['modules.youtube'] = true;
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start youtube']);
    assert.equal(platforms.wanted('youtube'), true);
    stored['modules.youtube'] = false;
    await config.load();
    await platforms.settled();
    assert.deepEqual(log, ['start youtube', 'stop youtube']);
    assert.equal(platforms.wanted('youtube'), false);
  } finally { config.stop(); }
});

test('a reader whose start throws is `failed` with one line; it is tried again on the next load, and its reason is printed once', async () => {
  const errors = [];
  let tries = 0;
  let fixed = false;
  let t = 1_000;
  const platforms = createPlatformStarter({
    starters: {
      youtube: async () => {
        tries += 1;
        if (!fixed) throw new Error('browserType.launch: Executable doesn\'t exist at /ms-playwright/chromium/headless_shell\n╔════════╗\n║ Looks like Playwright was just installed ║');
        return { stop() {} };
      },
    },
    choose: () => ({ enabled: ['youtube'], unknown: [], note: 'n', signatures: { youtube: 'x' } }),
    now: () => t,
    log: { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) },
  });
  await platforms.reconcile();
  const s = platforms.states().youtube;
  assert.equal(s.state, 'failed');
  assert.equal(s.error, 'browserType.launch: Executable doesn\'t exist at /ms-playwright/chromium/headless_shell');
  assert.doesNotMatch(s.error, /\n/);
  assert.equal(s.since, new Date(1_000).toISOString());
  t = 5_000;
  await platforms.reconcile('settings loaded');
  assert.equal(tries, 2, 'retried on the next load');
  assert.equal(errors.length, 1, `the same reason was printed again: ${errors.join(' | ')}`);
  assert.equal(platforms.states().youtube.since, new Date(1_000).toISOString(), 'still failing since the first failure');
  fixed = true;
  t = 9_000;
  await platforms.reconcile('settings loaded');
  assert.deepEqual(platforms.states().youtube, { state: 'running', since: new Date(9_000).toISOString(), error: '' });
});

test('a running reader that can tell refines its state (health()) — and a throwing health() is `failed`, not a crash', async () => {
  let h = { state: 'starting' };
  const platforms = createPlatformStarter({
    starters: { kick: async () => ({ stop() {}, health: () => { if (h === 'boom') throw new Error('bad'); return h; } }) },
    choose: () => ({ enabled: ['kick'], unknown: [], note: 'n', signatures: { kick: 'k' } }),
    log: quiet,
  });
  await platforms.reconcile();
  assert.equal(platforms.states().kick.state, 'starting');
  h = { state: 'failed', error: 'Kick refused the chatroom lookup — set the Kick chatroom id' };
  assert.deepEqual([platforms.states().kick.state, platforms.states().kick.error], ['failed', 'Kick refused the chatroom lookup — set the Kick chatroom id']);
  h = { state: 'running' };
  assert.equal(platforms.states().kick.state, 'running');
  h = 'boom';
  assert.equal(platforms.states().kick.state, 'failed');
});

test('oneLine: no stack, no URL path or query, at most 200 characters', () => {
  assert.equal(oneLine(new Error('fetch https://www.youtube.com/channel/UCabc/live?hl=en failed\n    at x (y.js:1:1)')), 'fetch www.youtube.com failed');
  assert.equal(oneLine('Login authentication failed'), 'Login authentication failed');
  assert.equal(oneLine(new Error('x'.repeat(500))).length, 200);
  assert.equal(oneLine(null), 'unknown error');
});
