// PLATFORMS: an explicit list wins; unset or empty reads the settings; "none" = no platforms.
// Run: node --test lib/platformsEnv.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlatforms, choosePlatforms } from './platformsEnv.js';

const KNOWN = ['twitch', 'kick', 'youtube', 'streamplace'];

test('unset, empty and "none" all mean no platforms — never all three', () => {
  for (const raw of [undefined, '', '   ', 'none', ' NONE ']) {
    const r = parsePlatforms(raw, KNOWN);
    assert.deepEqual(r.enabled, [], `PLATFORMS=${JSON.stringify(raw)} started ${r.enabled}`);
    assert.match(r.note, /no platform chat/);
  }
  assert.match(parsePlatforms(undefined, KNOWN).note, /PLATFORMS unset/);
});

test('a list is read in order, case-insensitively, deduplicated', () => {
  assert.deepEqual(parsePlatforms('twitch,kick,youtube,streamplace', KNOWN).enabled, KNOWN);
  assert.deepEqual(parsePlatforms(' Kick , twitch,kick ', KNOWN).enabled, ['kick', 'twitch']);
  assert.equal(parsePlatforms('twitch,kick', KNOWN).note, 'platforms: twitch, kick');
});

test('an unknown name is reported, not silently dropped', () => {
  const r = parsePlatforms('twitch,tiktok', KNOWN);
  assert.deepEqual(r.enabled, ['twitch']);
  assert.deepEqual(r.unknown, ['tiktok']);
  assert.match(r.note, /ignoring unknown name\(s\): tiktok/);
});

test('PLATFORMS unset or empty → the platforms the settings set up; YouTube only with its switch', () => {
  const settings = (over = {}) => (k) => ({
    'platform.twitch.channel': 'somechannel', 'platform.kick.slug': '', 'platform.youtube.channelId': 'UCabc',
    'platform.streamplace.did': 'did:plc:abc', 'modules.youtube': false, ...over,
  })[k] ?? null;
  for (const raw of [undefined, '', '   ']) {
    const r = choosePlatforms(raw, KNOWN, settings());
    assert.deepEqual(r.enabled, ['twitch', 'streamplace'], `raw ${JSON.stringify(raw)}`);
    assert.match(r.note, /settings.*YouTube is switched off/);
  }
  assert.deepEqual(choosePlatforms(undefined, KNOWN, settings({ 'modules.youtube': true })).enabled, ['twitch', 'youtube', 'streamplace']);
  assert.deepEqual(choosePlatforms(undefined, KNOWN, settings({ 'modules.youtube': true, 'platform.youtube.channelId': '' })).enabled, ['twitch', 'streamplace'],
    'switched on with no channel id: nothing to read');
  assert.deepEqual(choosePlatforms(undefined, KNOWN, () => null).enabled, [], 'a fresh install reads nothing');
  // An explicit PLATFORMS wins over the settings and the YouTube switch.
  assert.deepEqual(choosePlatforms('twitch,youtube', KNOWN, settings()).enabled, ['twitch', 'youtube']);
  assert.deepEqual(choosePlatforms('none', KNOWN, settings()).enabled, [], '"none" is an explicit list');
});
