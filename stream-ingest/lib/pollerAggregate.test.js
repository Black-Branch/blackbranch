// Which platforms get a vote, and what the vote says. sessionDecision() is tested next door
// for what it does with `anyPlatformLive`; this pins how `anyPlatformLive` and
// `allConfirmedOffline` are computed in the first place, including the two ways
// the tri-state can be mishandled:
//
//   • treating an unknown as offline, and
//   • treating a NOT-CONFIGURED platform as a permanent unknown — which would
//     make allConfirmedOffline unreachable and leave the session open forever.
//
// This file deliberately runs with NO Twitch credentials in env (node --test
// gives each file its own process), so it can also pin the unconfigured branch
// of twitchStatus, which the token-bearing pollerTwitchState.test.js cannot see.
//
// Run: node --test lib/pollerAggregate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TWITCH_OAUTH_TOKEN;
delete process.env.TWITCH_REFRESH_TOKEN;

const { aggregateLiveness, twitchStatus } = await import('./poller.js');

test('any one platform being live sustains the session', () => {
  // Twitch and YouTube ended; Kick keeps streaming. With only Twitch voting,
  // this would close the session.
  const r = aggregateLiveness([
    { name: 'twitch', state: 'offline' },
    { name: 'youtube', state: 'offline' },
    { name: 'kick', state: 'live' },
  ]);
  assert.equal(r.anyPlatformLive, true);
  assert.equal(r.allConfirmedOffline, false, 'one live platform must veto the close');
});

test('an unknown platform blocks the close without claiming to be live', () => {
  const r = aggregateLiveness([
    { name: 'twitch', state: 'unknown' },
    { name: 'kick', state: 'offline' },
  ]);
  assert.equal(r.anyPlatformLive, false, 'unknown is not evidence of being live');
  assert.equal(r.allConfirmedOffline, false, 'unknown is not evidence of being offline either');
});

test('the session closes only once every voting platform has confirmed offline', () => {
  const r = aggregateLiveness([
    { name: 'twitch', state: 'offline' },
    { name: 'kick', state: 'offline' },
    { name: 'youtube', state: 'offline' },
  ]);
  assert.equal(r.allConfirmedOffline, true);
  assert.equal(r.anyPlatformLive, false);
});

test('an unconfigured platform is excluded from the vote entirely, not held as unknown', () => {
  // If a missing-creds platform voted `unknown` forever, allConfirmedOffline
  // could never be true and the session would never close.
  const r = aggregateLiveness([
    { name: 'twitch', state: null },
    { name: 'kick', state: 'offline' },
    { name: 'youtube', state: null },
  ]);
  assert.equal(r.allConfirmedOffline, true, 'an unconfigured platform must not wedge the close');
  assert.deepEqual(r.voting.map((p) => p.name), ['kick']);
});

test('no configured platform at all is not "everyone confirmed offline"', () => {
  // `[].every(...)` is vacuously true — that would end sessions off zero evidence.
  const r = aggregateLiveness([{ name: 'twitch', state: null }]);
  assert.equal(r.allConfirmedOffline, false);
  assert.equal(r.anyPlatformLive, false);
});

test('twitchStatus with no credentials is not configured (null), never a confirmed offline', async () => {
  const r = await twitchStatus();
  assert.equal(r.state, null,
    'no token is "Twitch is not part of this setup", which is different from "Twitch is not live"');
});
