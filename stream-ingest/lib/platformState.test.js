// The per-platform state model (lib/platformState.js): one row of the plan's table per test.
// It replaces createMissCounter; the rows marked † in the plan are that counter's old cases.
//
// Run: node --test lib/platformState.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { platformState, voteOf, formatStatesLine, transitionLine } from './platformState.js';
import { PLATFORM_LIVENESS } from './platformLiveness.generated.js';

const C = PLATFORM_LIVENESS.OFFLINE_CONFIRMATIONS;
const T0 = Date.parse('2026-10-23T09:56:53Z');
const NOW = T0 + 60_000;

const obs = (raw, extra = {}) => ({ raw, certain: false, key: '', evidence: 'helix-empty', ...extra });
const st = (state, extra = {}) => ({
  state, since: T0 - 3_600_000, lastAnswerAt: T0, misses: 0, key: 'k-prev', evidence: 'helix-live', scheduledStart: null, ...extra,
});

test('the vocabulary confirms an uncertain offline on the second answered reading', () => {
  assert.equal(C, 2);
});

// ── the table ───────────────────────────────────────────────────────────────

test('row: any prev, no observation → null (not configured: no vote)', () => {
  assert.equal(platformState(null, null, NOW), null);
  assert.equal(platformState(st('live'), null, NOW), null);
});

test('row †: any prev, live → live at once, misses reset, answered now', () => {
  for (const prev of [null, st('offline', { misses: 3 }), st('unknown', { misses: 1, evidence: 'offline-pending' }), st('upcoming')]) {
    const s = platformState(prev, obs('live', { key: 'stream-42', evidence: 'helix-live' }), NOW);
    assert.equal(s.state, 'live');
    assert.equal(s.misses, 0);
    assert.equal(s.lastAnswerAt, NOW);
    assert.equal(s.key, 'stream-42');
    assert.equal(s.evidence, 'helix-live');
  }
});

test('row: any prev, upcoming → upcoming, misses reset, scheduledStart copied', () => {
  const start = NOW + 3_600_000;
  for (const prev of [null, st('live'), st('offline', { misses: 4 }), st('unknown', { misses: 1 })]) {
    const s = platformState(prev, obs('upcoming', { key: 'vid', evidence: 'upcoming', scheduledStart: start }), NOW);
    assert.equal(s.state, 'upcoming');
    assert.equal(s.misses, 0);
    assert.equal(s.lastAnswerAt, NOW);
    assert.equal(s.scheduledStart, start);
    assert.equal(s.key, 'vid');
  }
});

test('row: null / live / unknown (m), a certain offline → offline at once, m+1', () => {
  for (const [prev, m] of [[null, 0], [st('live'), 0], [st('unknown', { misses: 1 }), 1]]) {
    const s = platformState(prev, obs('offline', { certain: true, evidence: 'ended-stamp' }), NOW);
    assert.equal(s.state, 'offline', `from ${prev?.state ?? 'null'}`);
    assert.equal(s.misses, m + 1);
    assert.equal(s.lastAnswerAt, NOW);
    assert.equal(s.evidence, 'ended-stamp');
  }
});

test('row: upcoming, any offline → offline, misses 1 (a schedule already votes offline; no pending step)', () => {
  for (const certain of [false, true]) {
    const s = platformState(st('upcoming', { scheduledStart: NOW + 1 }), obs('offline', { certain, evidence: 'not-live' }), NOW);
    assert.equal(s.state, 'offline');
    assert.equal(s.misses, 1);
    assert.equal(s.lastAnswerAt, NOW);
  }
});

test('row †: null / live / unknown (m), m+1 < C, an uncertain offline → unknown, offline-pending', () => {
  for (const prev of [null, st('live'), st('unknown', { misses: 0, evidence: 'helix-error' })]) {
    const s = platformState(prev, obs('offline'), NOW);
    assert.equal(s.state, 'unknown', `from ${prev?.state ?? 'null'}: the first answered offline must not end anything`);
    assert.equal(s.evidence, PLATFORM_LIVENESS.PENDING_EVIDENCE);
    assert.equal(s.evidence, 'offline-pending');
    assert.equal(s.misses, 1);
    assert.equal(s.lastAnswerAt, NOW, 'an answered offline IS an answer');
  }
});

test('row †: unknown (m), m+1 ≥ C, an uncertain offline → offline', () => {
  const s = platformState(st('unknown', { misses: C - 1, evidence: 'offline-pending' }), obs('offline'), NOW);
  assert.equal(s.state, 'offline');
  assert.equal(s.misses, C);
  assert.equal(s.lastAnswerAt, NOW);
  assert.equal(s.evidence, 'helix-empty');
});

test('row: offline (m), any offline → offline, m+1', () => {
  for (const certain of [false, true]) {
    const s = platformState(st('offline', { misses: 5 }), obs('offline', { certain }), NOW);
    assert.equal(s.state, 'offline');
    assert.equal(s.misses, 6);
    assert.equal(s.lastAnswerAt, NOW);
  }
});

test('row †: any (m), unknown → unknown, misses kept, lastAnswerAt kept (it is not an answer)', () => {
  for (const prev of [st('live'), st('offline', { misses: 3 }), st('unknown', { misses: 1, evidence: 'offline-pending' }), st('upcoming')]) {
    const s = platformState(prev, obs('unknown', { evidence: 'helix-error' }), NOW);
    assert.equal(s.state, 'unknown');
    assert.equal(s.misses, prev.misses, 'unknown neither adds nor resets');
    assert.equal(s.lastAnswerAt, prev.lastAnswerAt);
    assert.equal(s.evidence, 'helix-error');
  }
  const first = platformState(null, obs('unknown', { evidence: 'no-token' }), NOW);
  assert.deepEqual([first.state, first.misses, first.lastAnswerAt], ['unknown', 0, null]);
});

test('row †: unknowns never resolve to offline on their own, however many', () => {
  let s = platformState(st('unknown', { misses: 1, evidence: 'offline-pending' }), obs('unknown', { evidence: 'helix-error' }), NOW);
  for (let i = 0; i < 10; i++) s = platformState(s, obs('unknown', { evidence: 'helix-error' }), NOW + i);
  assert.equal(s.state, 'unknown');
  assert.equal(s.misses, 1);
});

test('row †: a live between two offlines resets the count', () => {
  let s = platformState(st('live'), obs('offline'), NOW);
  s = platformState(s, obs('live', { evidence: 'helix-live' }), NOW + 1);
  s = platformState(s, obs('offline'), NOW + 2);
  assert.equal(s.state, 'unknown', 'the reset cleared the prior miss');
  assert.equal(s.misses, 1);
});

test('row: an unknown between two answered offlines does not reset the count', () => {
  let s = platformState(st('live'), obs('offline'), NOW);
  s = platformState(s, obs('unknown', { evidence: 'helix-error' }), NOW + 1);
  s = platformState(s, obs('offline'), NOW + 2);
  assert.equal(s.state, 'offline');
});

// ── since / key ─────────────────────────────────────────────────────────────

test('since changes only when the state changes', () => {
  const live = platformState(null, obs('live', { key: 'a' }), NOW);
  assert.equal(live.since, NOW);
  const still = platformState(live, obs('live', { key: 'a' }), NOW + 60_000);
  assert.equal(still.since, NOW);
  const pending = platformState(still, obs('offline'), NOW + 120_000);
  assert.equal(pending.since, NOW + 120_000);
  const unk = platformState(pending, obs('unknown', { evidence: 'helix-error' }), NOW + 180_000);
  assert.equal(unk.since, NOW + 120_000, 'unknown → unknown keeps since');
});

test('key and scheduledStart come from an answered observation, and an unknown keeps the previous ones', () => {
  const up = platformState(null, obs('upcoming', { key: 'vid1', evidence: 'upcoming', scheduledStart: 123 }), NOW);
  const unk = platformState(up, obs('unknown', { key: '', evidence: 'no-player-response' }), NOW + 1);
  assert.equal(unk.key, 'vid1');
  assert.equal(unk.scheduledStart, 123);
  const live = platformState(unk, obs('live', { key: 'vid1', evidence: 'is-live' }), NOW + 2);
  assert.equal(live.scheduledStart, null, 'an answered observation without a schedule clears it');
});

// ── voteOf ──────────────────────────────────────────────────────────────────

test('voteOf: every state', () => {
  assert.equal(voteOf(null), null);
  assert.equal(voteOf(st('live')), 'live');
  assert.equal(voteOf(st('offline')), 'offline');
  assert.equal(voteOf(st('unknown')), 'unknown');
  assert.equal(voteOf(st('upcoming')), 'offline', 'a scheduled broadcast is never live and never holds the night');
});

test('a scheduled stream never holds the night open: upcoming votes offline in the aggregate', async () => {
  const { aggregateLiveness } = await import('./poller.js');
  assert.equal(aggregateLiveness([{ state: voteOf(st('upcoming')) }, { state: 'offline' }]).allConfirmedOffline, true);
  assert.equal(aggregateLiveness([{ state: voteOf(st('upcoming')) }, { state: 'offline' }]).anyPlatformLive, false);
});

// ── the YouTube observation, from Task 1's reading ─────────────────────────

test('youtubeObservation carries the reading\'s own certainty, evidence, key and start (Task 4); the source names a reading that has no evidence', async () => {
  const { youtubeObservation } = await import('./poller.js');
  const VID = 'dQw4w9WgXcQ';
  const START = Date.parse('2026-10-24T20:00:00Z');
  assert.deepEqual(youtubeObservation({ raw: 'live', certain: false, key: VID, evidence: 'is-live', scheduledStart: null, videoId: VID }, 'reader'),
    { raw: 'live', certain: false, key: VID, evidence: 'is-live', scheduledStart: null });
  assert.deepEqual(youtubeObservation({ raw: 'offline', certain: true, key: '', evidence: 'not-live', scheduledStart: null, videoId: '' }, 'reader'),
    { raw: 'offline', certain: true, key: '', evidence: 'not-live', scheduledStart: null }, 'a certain end stays certain');
  assert.deepEqual(youtubeObservation({ raw: 'upcoming', certain: false, key: VID, evidence: 'upcoming', scheduledStart: START, videoId: '' }, 'lookup'),
    { raw: 'upcoming', certain: false, key: VID, evidence: 'upcoming', scheduledStart: START });
  assert.deepEqual(youtubeObservation({ raw: 'unknown', videoId: '' }, 'lookup'),
    { raw: 'unknown', certain: false, key: '', evidence: 'yt-lookup', scheduledStart: null }, 'no evidence of its own: the source');
  assert.deepEqual(youtubeObservation({ raw: 'offline', videoId: '' }, 'reader'),
    { raw: 'offline', certain: false, key: '', evidence: 'yt-reader', scheduledStart: null }, 'no certainty stated is not certain');
  assert.equal(youtubeObservation(null, 'reader'), null);
  assert.equal(youtubeObservation(null, 'lookup'), null);
});

// ── the log lines ───────────────────────────────────────────────────────────

test('formatStatesLine keeps the prefix and says what each platform answered', () => {
  const line = formatStatesLine({
    twitch: st('unknown', { misses: 1, evidence: 'offline-pending' }),
    kick: st('live'),
    youtube: st('unknown', { evidence: 'no-player-response' }),
    streamplace: st('offline', { misses: 2 }),
  });
  assert.equal(line, '[poller] platform states: twitch=offline(1/2) kick=live youtube=unknown(no-player-response) streamplace=offline');
});

test('formatStatesLine names an unconfigured platform and a scheduled one', () => {
  assert.equal(
    formatStatesLine({ twitch: null, kick: null, youtube: st('upcoming'), streamplace: null }),
    '[poller] platform states: twitch=unconfigured kick=unconfigured youtube=upcoming streamplace=unconfigured',
  );
});

test('transitionLine: one line on a change, with the evidence and the key', () => {
  assert.equal(
    transitionLine('youtube', st('live', { key: 'abc' }), st('offline', { key: 'abc', evidence: 'not-live' })),
    '[liveness] youtube live→offline (not-live on abc)',
  );
  assert.equal(
    transitionLine('twitch', st('live', { key: '42' }), st('unknown', { key: '', evidence: 'offline-pending', misses: 1 })),
    '[liveness] twitch live→unknown (offline-pending on 42)',
    'an answered offline carries no key; the line names the broadcast that ended',
  );
  assert.equal(transitionLine('kick', null, st('live', { key: '', evidence: 'kick-live' })), '[liveness] kick none→live (kick-live)');
  assert.equal(transitionLine('kick', st('live'), null), '[liveness] kick live→none');
});

test('transitionLine: nothing when the state did not change', () => {
  assert.equal(transitionLine('twitch', st('live'), st('live')), null);
  assert.equal(transitionLine('twitch', null, null), null);
  assert.equal(transitionLine('twitch', st('unknown', { evidence: 'offline-pending' }), st('unknown', { evidence: 'helix-error' })), null);
});

// ── restart and retry ───────────────────────────────────────────────────────

test('restart: a fresh process has no history, so its first uncertain offline is still only pending', async () => {
  const fresh = await import(`./platformState.js?restart=${Date.now()}`);
  const s = fresh.platformState(null, obs('offline'), NOW);
  assert.equal(s.state, 'unknown', 'a restart must not turn one answered offline into an end');
  assert.equal(fresh.platformState(null, obs('offline', { certain: true, evidence: 'ended-stamp' }), NOW).state, 'offline',
    'a certain end still counts at once after a restart');
});

test('retry: the same answered offline asked again is its confirmation; the same unknown again changes nothing', () => {
  const once = platformState(st('live'), obs('offline'), NOW);
  const twice = platformState(once, obs('offline'), NOW + 60_000);
  assert.equal(twice.state, 'offline');
  const u1 = platformState(st('live'), obs('unknown', { evidence: 'helix-error' }), NOW);
  const u2 = platformState(u1, obs('unknown', { evidence: 'helix-error' }), NOW + 60_000);
  assert.deepEqual([u2.state, u2.misses, u2.lastAnswerAt], ['unknown', 0, T0]);
});

test('platformState is pure: it does not mutate its inputs', () => {
  const prev = Object.freeze(st('live'));
  const o = Object.freeze(obs('offline'));
  assert.doesNotThrow(() => platformState(prev, o, NOW));
});

test('staleAnswer (the vocabulary\'s one 15-minute rule)', () => {
  const S = PLATFORM_LIVENESS.STALE_ANSWER_MS;
  assert.equal(PLATFORM_LIVENESS.staleAnswer(st('live', { lastAnswerAt: NOW - 1000 }), NOW), false);
  assert.equal(PLATFORM_LIVENESS.staleAnswer(st('live', { lastAnswerAt: NOW - S - 1 }), NOW), true);
  assert.equal(PLATFORM_LIVENESS.staleAnswer(st('unknown', { lastAnswerAt: null, since: NOW - S - 1 }), NOW), true);
  assert.equal(PLATFORM_LIVENESS.staleAnswer(st('unknown', { lastAnswerAt: null, since: NOW - 1000 }), NOW), false);
  assert.equal(PLATFORM_LIVENESS.staleAnswer(null, NOW), false);
});

// ── one vocabulary: the model names no platform, state or code itself ───────
// A negative scan (no such literal), so it ends with its vacuity anchor: the module's LAST
// function must sit in the scanned text's tail, or the scan read a short file.
test('platformState.js holds no platform, state or evidence literal (the vocabulary owns them)', async () => {
  const { readFileSync } = await import('node:fs');
  const { stripComments } = await import('../../web/app/lib/sourceText.mjs');
  const src = stripComments(readFileSync(new URL('./platformState.js', import.meta.url), 'utf8'));
  const words = [...PLATFORM_LIVENESS.PLATFORMS, ...Object.values(PLATFORM_LIVENESS.STATES), ...Object.keys(PLATFORM_LIVENESS.EVIDENCE)];
  assert.ok(words.length > 30, 'the vocabulary was read');
  const literals = [...src.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]);
  for (const w of words) {
    assert.ok(!literals.includes(w), `platformState.js spells '${w}' itself — read it from PLATFORM_LIVENESS`);
  }
  const tail = src.trimEnd().slice(-700);
  assert.match(tail, /export function transitionLine\(/, 'vacuity anchor: the last function is in the scanned tail');
});
