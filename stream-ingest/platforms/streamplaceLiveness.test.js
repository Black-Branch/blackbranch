// stream.place's live vote, from its own chat socket.
//
// Only the poller opens a session, so without this vote a stream.place-only install never goes
// live: no live player, a timer that never runs, no watch points. The socket carries the
// channel's livestream record — the shapes below are the ones stream.place sent on 2026-10-21 for a
// channel that was live, one whose stream had ended, and one that never streamed (values made up).
//
// Run: node --test platforms/streamplaceLiveness.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { streamplaceLiveness } from './streamplace.js';

const NOW = Date.parse('2026-10-21T02:46:30Z');
const up = { connected: true, connectedAt: NOW - 60_000, lastFrameAt: NOW - 1_000, now: NOW };
const liveRecord = {
  $type: 'place.stream.livestream', title: 'a stream', createdAt: '2026-10-18T15:20:50Z',
  idleTimeoutSeconds: 300, lastSeenAt: '2026-10-21T02:46:23.273Z', url: 'https://stream.place/did:plc:casey',
};
const endedRecord = { ...liveRecord, lastSeenAt: '2026-10-19T22:39:00.452Z', endedAt: '2026-10-19T22:39:16.179Z' };

test('a record seen within its idle window, with no endedAt, is live', () => {
  assert.equal(streamplaceLiveness({ ...up, record: liveRecord }), 'live');
});

test('a record with endedAt is offline', () => {
  assert.equal(streamplaceLiveness({ ...up, record: endedRecord }), 'offline');
});

test('a record not seen for longer than its idleTimeoutSeconds is offline (stream.place\'s own "gone" rule)', () => {
  assert.equal(streamplaceLiveness({ ...up, record: { ...liveRecord, lastSeenAt: '2026-10-21T02:40:00Z' } }), 'offline');
  assert.equal(streamplaceLiveness({ ...up, record: { ...liveRecord, idleTimeoutSeconds: 600, lastSeenAt: '2026-10-21T02:40:00Z' } }), 'live');
});

test('a channel that never streamed sends no record: offline once the socket has been up 20 s, unknown before', () => {
  assert.equal(streamplaceLiveness({ ...up, record: null }), 'offline');
  assert.equal(streamplaceLiveness({ ...up, connectedAt: NOW - 5_000, record: null }), 'unknown');
});

test('no socket, or a silent one, is no evidence: unknown — never offline', () => {
  assert.equal(streamplaceLiveness({ ...up, connected: false, record: liveRecord }), 'unknown');
  assert.equal(streamplaceLiveness({ ...up, lastFrameAt: NOW - 120_000, record: endedRecord }), 'unknown');
  assert.equal(streamplaceLiveness({ ...up, record: { ...liveRecord, lastSeenAt: 'garbage' } }), 'unknown');
});
