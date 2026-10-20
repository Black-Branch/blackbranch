// Run: node --test lib/pollerCadence.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay } from './poller.js';

test('a session being open uses the fast (live) cadence', () => {
  assert.equal(nextPollDelay(true), 60000);
});

test('no session open uses the slow (idle) cadence', () => {
  assert.equal(nextPollDelay(false), 180000);
});

test('the idle cadence is strictly slower than the live cadence', () => {
  assert.ok(nextPollDelay(false) > nextPollDelay(true),
    'an idle cadence that is not slower than live defeats the whole point of this task');
});
