// Run: node --test lib/pollerMissCounter.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMissCounter } from './poller.js';

test('a live reading is never delayed', () => {
  const c = createMissCounter(2);
  assert.equal(c.record('live'), 'live');
});

test('offline is withheld until the threshold is reached', () => {
  const c = createMissCounter(2);
  assert.equal(c.record('offline'), 'unknown', 'first miss must not declare offline yet');
  assert.equal(c.record('offline'), 'offline', 'second consecutive miss reaches the threshold');
});

test('a live reading resets the miss count', () => {
  const c = createMissCounter(2);
  assert.equal(c.record('offline'), 'unknown');
  assert.equal(c.record('live'), 'live');
  assert.equal(c.record('offline'), 'unknown', 'the reset must have cleared the prior miss');
});

test('unknown never advances the offline count and never resolves to offline on its own', () => {
  const c = createMissCounter(2);
  assert.equal(c.record('unknown'), 'unknown');
  assert.equal(c.record('unknown'), 'unknown');
  assert.equal(c.record('unknown'), 'unknown', 'ten unknowns must still not become offline');
});

test('a threshold of 1 declares offline on the first miss', () => {
  const c = createMissCounter(1);
  assert.equal(c.record('offline'), 'offline');
});

test('youtube goes through the same hysteresis as twitch and kick', () => {
  // A transient failure to resolve the live video id must not read like the
  // stream ending, so ytState goes through a miss counter rather than a bare
  // `getYtVideoId() !== '' ? live : offline`.
  const src = readFileSync(new URL('./poller.js', import.meta.url), 'utf8');
  assert.match(src, /const ytOffline = createMissCounter\(/,
    'youtube needs its own miss counter, like twOffline and kickOffline');
  assert.match(src, /ytOffline\.record\(/,
    'and the state must actually be recorded through it');
  assert.doesNotMatch(src, /ytState = ytConfigured \? \(getYtVideoId\(\) !== '' \? 'live' : 'offline'\)/,
    'the un-hysteresised expression must be gone, not merely wrapped');
});

// Vacuity anchor, deliberately LAST: the scan above includes a negative
// assertion (the un-hysteresised expression must be absent), and a negative
// assertion passes over an empty or wrong file. Prove the read reached the real
// poller.js by finding two things that must still be there.
test('the scanned poller.js is the real one and still defines what the scan assumes', () => {
  const src = readFileSync(new URL('./poller.js', import.meta.url), 'utf8');
  assert.match(src, /function createMissCounter\(/, 'createMissCounter is gone — the whole scan is reading the wrong file');
  assert.match(src, /\[poller\] platform states: /, 'the cadence log line is gone — youtube= no longer has a line to be reported on');
});
