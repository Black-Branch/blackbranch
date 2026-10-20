// Platform chat readers after a failed first settings load (external review, startup recovery).
//
// index.js used to ignore what `instanceConfig.start()` returned and choose the platforms once.
// When stream-api was briefly unreachable at boot, that choice was made from env + defaults: on an
// install whose channels live only in the database it selected nothing, and when the settings
// arrived seconds later nothing started the readers — no platform chat until a manual restart.
// Here a real settings reader fails its first load and recovers; the starters are spies.
//
// Run: node --test lib/platformStarter.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInstanceConfig } from './instanceConfig.js';
import { choosePlatforms } from './platformsEnv.js';
import { createPlatformStarter, startPlatformsWhenLoaded } from './platformStarter.js';

process.env.STREAM_API_URL = 'http://stream-api.test';

const quiet = { log() {}, warn() {}, error() {} };
const json = (body) => ({ ok: true, status: 200, json: async () => body });
class NoSocket { on() {} close() {} }

/** A settings reader whose stream-api is down until `up()`; the stored channels are Kick + stream.place. */
function reader() {
  let down = true;
  const stored = { 'platform.kick.slug': 'casey-test', 'platform.streamplace.did': 'did:plc:caseytest' };
  const fetchImpl = async (url) => {
    if (down) throw new Error('ECONNREFUSED');
    const u = String(url);
    if (u.endsWith('/config')) return json({ values: stored });
    if (u.includes('/config/secrets')) return json({ values: {}, unreadable: [] });
    if (u.endsWith('/content')) return json({ content: {} });
    return json({});
  };
  const config = createInstanceConfig({ env: { STREAM_API_URL: 'http://stream-api.test' }, fetchImpl, WebSocketImpl: NoSocket, log: quiet });
  return { config, up: () => { down = false; } };
}

function spies() {
  const calls = { twitch: 0, kick: 0, youtube: 0, streamplace: 0 };
  const starters = Object.fromEntries(Object.keys(calls).map((name) => [name, async () => {
    calls[name] += 1;
    return { stop() {}, name };
  }]));
  return { calls, starters };
}

const starterFor = (config, starters) => createPlatformStarter({
  starters,
  choose: () => choosePlatforms(undefined, Object.keys(starters), (k) => config.get(k)),
  log: quiet,
});

test('a failed first load, then recovery: the readers the settings name start, once', async () => {
  const { config, up } = reader();
  const { calls, starters } = spies();
  try {
    const bootLoaded = await config.start();
    assert.equal(bootLoaded, false, 'the first load fails');
    const platforms = starterFor(config, starters);
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded, log: quiet });
    assert.deepEqual(calls, { twitch: 0, kick: 0, youtube: 0, streamplace: 0 }, 'nothing is known yet, so nothing starts');

    up();
    assert.equal(await config.load(), true);
    await platforms.settled();
    assert.deepEqual(calls, { twitch: 0, kick: 1, youtube: 0, streamplace: 1 }, 'the stored channels start when the settings arrive');
    assert.equal(platforms.handle('kick').name, 'kick');

    // Every later load (reconnects, config_changed, the 5-minute backstop) must not start a second reader.
    await config.load();
    await config.load();
    await platforms.settled();
    assert.deepEqual(calls, { twitch: 0, kick: 1, youtube: 0, streamplace: 1 }, 'no duplicate readers on later loads');
  } finally { config.stop(); }
});

test('a load that lands while the boot start is still running starts nothing twice', async () => {
  const { config, up } = reader();
  const calls = { kick: 0, streamplace: 0, twitch: 0, youtube: 0 };
  let release;
  const gate = new Promise((r) => { release = r; });
  const starters = {
    twitch: async () => { calls.twitch += 1; return {}; },
    youtube: async () => { calls.youtube += 1; return {}; },
    kick: async () => { calls.kick += 1; await gate; return { stop() {} }; },
    streamplace: async () => { calls.streamplace += 1; return { stop() {} }; },
  };
  try {
    const bootLoaded = await config.start();
    up();
    // PLATFORMS-style env choice that names kick at boot, so the boot pass is mid-start when the
    // settings arrive.
    const platforms = createPlatformStarter({ starters, choose: () => choosePlatforms('kick,streamplace', Object.keys(starters), (k) => config.get(k)), log: quiet });
    const boot = startPlatformsWhenLoaded({ platforms, config, bootLoaded, log: quiet });
    await config.load();
    release();
    await boot;
    await platforms.settled();
    assert.deepEqual(calls, { kick: 1, streamplace: 1, twitch: 0, youtube: 0 });
  } finally { config.stop(); }
});

test('a first load that succeeds: one start at boot, and later loads start nothing', async () => {
  const { config, up } = reader();
  const { calls, starters } = spies();
  up();
  try {
    const bootLoaded = await config.start();
    assert.equal(bootLoaded, true);
    const platforms = starterFor(config, starters);
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded, log: quiet });
    assert.deepEqual(calls, { twitch: 0, kick: 1, youtube: 0, streamplace: 1 });
    await config.load();
    await platforms.settled();
    assert.deepEqual(calls, { twitch: 0, kick: 1, youtube: 0, streamplace: 1 });
  } finally { config.stop(); }
});

test('a reader that failed to start before the settings arrived is tried again when they do', async () => {
  const { config, up } = reader();
  let kickTries = 0;
  const starters = {
    twitch: async () => ({}), youtube: async () => ({}), streamplace: async () => ({ stop() {} }),
    // The real startKick throws while the slug is unknown.
    kick: async () => { kickTries += 1; if (!config.get('platform.kick.slug')) throw new Error('platform.kick.slug is not set'); return { stop() {} }; },
  };
  try {
    const bootLoaded = await config.start();
    const platforms = createPlatformStarter({ starters, choose: () => choosePlatforms('kick', Object.keys(starters), (k) => config.get(k)), log: quiet });
    await startPlatformsWhenLoaded({ platforms, config, bootLoaded, log: quiet });
    assert.equal(kickTries, 1);
    assert.equal(platforms.handle('kick'), null);
    up();
    await config.load();
    await platforms.settled();
    assert.equal(kickTries, 2);
    assert.ok(platforms.handle('kick'));
  } finally { config.stop(); }
});

test('index.js starts the platforms through startPlatformsWhenLoaded with the boot load\'s result', () => {
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8');
  assert.match(src, /main\(\)\.catch\([\s\S]*\}\);\s*$/, 'read to the end of index.js');
  assert.match(src, /const bootLoaded = await instanceConfig\.start\(\);/);
  assert.match(src, /await startPlatformsWhenLoaded\(\{ platforms, config: instanceConfig, bootLoaded \}\);/);
  assert.doesNotMatch(src, /for \(const name of enabled\)/, 'the old one-shot start loop is gone');
});
