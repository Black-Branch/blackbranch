// stream.place's live vote, from its own chat socket.
//
// Only the poller opens a session, so without this vote a stream.place-only install never goes
// live: no live player, a timer that never runs, no watch points. The socket carries the
// channel's livestream record — the shapes below are the ones stream.place sent on 2026-10-21 for a
// channel that was live, one whose stream had ended, and one that never streamed (values made up).
//
// Run: node --test platforms/streamplaceObservation.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { streamplaceObservation } from './streamplace.js';

const raw = (s) => streamplaceObservation(s).raw;

const NOW = Date.parse('2026-10-21T02:46:30Z');
const up = { connected: true, connectedAt: NOW - 60_000, lastFrameAt: NOW - 1_000, now: NOW };
const liveRecord = {
  $type: 'place.stream.livestream', title: 'a stream', createdAt: '2026-10-18T15:20:50Z',
  idleTimeoutSeconds: 300, lastSeenAt: '2026-10-21T02:46:23.273Z', url: 'https://stream.place/did:plc:casey',
};
const endedRecord = { ...liveRecord, lastSeenAt: '2026-10-19T22:39:00.452Z', endedAt: '2026-10-19T22:39:16.179Z' };

test('a record seen within its idle window, with no endedAt, is live', () => {
  assert.equal(raw({ ...up, record: liveRecord }), 'live');
});

test('a record with endedAt is offline', () => {
  assert.equal(raw({ ...up, record: endedRecord }), 'offline');
});

test('a record not seen for longer than its idleTimeoutSeconds is offline (stream.place\'s own "gone" rule)', () => {
  assert.equal(raw({ ...up, record: { ...liveRecord, lastSeenAt: '2026-10-21T02:40:00Z' } }), 'offline');
  assert.equal(raw({ ...up, record: { ...liveRecord, idleTimeoutSeconds: 600, lastSeenAt: '2026-10-21T02:40:00Z' } }), 'live');
});

test('a channel that never streamed sends no record: offline once the socket has been up 20 s, unknown before', () => {
  assert.equal(raw({ ...up, record: null }), 'offline');
  assert.equal(raw({ ...up, connectedAt: NOW - 5_000, record: null }), 'unknown');
});

test('no socket, or a silent one, is no evidence: unknown — never offline', () => {
  assert.equal(raw({ ...up, connected: false, record: liveRecord }), 'unknown');
  assert.equal(raw({ ...up, lastFrameAt: NOW - 120_000, record: endedRecord }), 'unknown');
  assert.equal(raw({ ...up, record: { ...liveRecord, lastSeenAt: 'garbage' } }), 'unknown');
});

test('the observation: only the ended stamp is certain, the record uri is the key, and each branch names its evidence', () => {
  const uri = 'at://did:plc:casey/place.stream.livestream/3l0abc';
  assert.deepEqual(streamplaceObservation({ ...up, record: endedRecord, uri }), { raw: 'offline', certain: true, key: uri, evidence: 'ended-stamp' });
  assert.deepEqual(streamplaceObservation({ ...up, record: liveRecord, uri }), { raw: 'live', certain: false, key: uri, evidence: 'record-live' });
  assert.deepEqual(streamplaceObservation({ ...up, record: { ...liveRecord, lastSeenAt: '2026-10-21T02:40:00Z' }, uri }),
    { raw: 'offline', certain: false, key: uri, evidence: 'record-idle' }, 'an idle record still needs a second reading');
  assert.deepEqual(streamplaceObservation({ ...up, record: null, uri }), { raw: 'offline', certain: false, key: '', evidence: 'no-record' });
  assert.deepEqual(streamplaceObservation({ ...up, lastFrameAt: NOW - 120_000, record: endedRecord, uri }),
    { raw: 'unknown', certain: false, key: uri, evidence: 'socket-quiet' }, 'a quiet socket says nothing, even over an ended record');
});
