// Push hints: a platform's own realtime "started" / "stopped" signal (Kick's channel events, the
// stream.place ended stamp). A hint only wakes the poller for an immediate read; the read's answer
// is what counts (ADR 0134 E7/E11), so this module only remembers the last hint per platform and
// tells its listeners.
//
// Run: node --test lib/liveHints.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { noteHint, lastHint, onHint } from './liveHints.js';

test('lastHint is null for a platform that never sent one', () => {
  assert.equal(lastHint('twitch'), null);
});

test('noteHint records the last hint per platform, with its time', () => {
  noteHint('kick', 'stop', 1_000);
  assert.deepEqual(lastHint('kick'), { kind: 'stop', at: 1_000 });
  noteHint('kick', 'live', 2_000);
  assert.deepEqual(lastHint('kick'), { kind: 'live', at: 2_000 }, 'a newer hint replaces the older one');
  noteHint('streamplace', 'stop', 3_000);
  assert.deepEqual(lastHint('kick'), { kind: 'live', at: 2_000 }, 'platforms are kept apart');
  assert.deepEqual(lastHint('streamplace'), { kind: 'stop', at: 3_000 });
});

test('the time defaults to now', () => {
  const before = Date.now();
  noteHint('streamplace', 'live');
  const h = lastHint('streamplace');
  assert.equal(h.kind, 'live');
  assert.ok(h.at >= before && h.at <= Date.now());
});

test('lastHint returns a copy: a caller cannot change the remembered hint', () => {
  noteHint('kick', 'stop', 5_000);
  const h = lastHint('kick');
  h.kind = 'live';
  h.at = 0;
  assert.deepEqual(lastHint('kick'), { kind: 'stop', at: 5_000 });
});

test('a listener hears every hint, and stops hearing once it unsubscribes', () => {
  const heard = [];
  const off = onHint((h) => heard.push(h));
  noteHint('kick', 'stop', 7_000);
  noteHint('streamplace', 'live', 8_000);
  off();
  noteHint('kick', 'live', 9_000);
  assert.deepEqual(heard, [
    { platform: 'kick', kind: 'stop', at: 7_000 },
    { platform: 'streamplace', kind: 'live', at: 8_000 },
  ]);
});

test('a listener that throws does not stop the others, and the hint is still remembered', () => {
  const heard = [];
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  const offA = onHint(() => { throw new Error('boom'); });
  const offB = onHint((h) => heard.push(h.kind));
  try {
    noteHint('kick', 'stop', 10_000);
  } finally {
    offA();
    offB();
    console.warn = warn;
  }
  assert.deepEqual(heard, ['stop']);
  assert.deepEqual(lastHint('kick'), { kind: 'stop', at: 10_000 });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^\[hints\] a listener failed on kick stop: boom$/);
});

test('an unknown platform or kind is refused, not remembered and not told', () => {
  const heard = [];
  const off = onHint((h) => heard.push(h));
  try {
    assert.throws(() => noteHint('myspace', 'stop'), /unknown platform myspace/);
    assert.throws(() => noteHint('kick', 'ended'), /unknown hint kind ended/);
  } finally {
    off();
  }
  assert.deepEqual(heard, []);
  assert.equal(lastHint('myspace'), null);
});
