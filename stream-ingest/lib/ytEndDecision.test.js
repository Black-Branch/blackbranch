// decideEnd: a failed live-lookup against a HEALTHY chat continuation is
// "unknown", never a step toward "ended" — a false end closes the chat
// mid-stream and leaves a blind gap.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideEnd, decideWatch, watcherVote, chatPlan, chatPollDelay, END_HOLD_MS, END_MISS_THRESHOLD,
  YT_WAITING_ROOM_MS, COUNTDOWN_POLL_MS,
} from './ytEndDecision.js';
import { STALL_MS } from './ytWatchdog.js';

test('healthy chat holds the miss counter at zero (no false end)', () => {
  // Chat delivered 2s ago while the lookup fails — the false-close shape.
  const d = decideEnd({ missCount: 2, msSinceChatOk: 2_000 });
  assert.equal(d.action, 'hold');
  assert.equal(d.missCount, 0, 'the hold RESETS the counter — stale misses must not bank');
});

test('quiet chat counts misses and closes at the threshold (real end unchanged)', () => {
  let missCount = 0;
  const stale = END_HOLD_MS + 1;
  let d = decideEnd({ missCount, msSinceChatOk: stale });
  assert.deepEqual(d, { action: 'count', missCount: 1 });
  d = decideEnd({ missCount: d.missCount, msSinceChatOk: stale });
  assert.deepEqual(d, { action: 'count', missCount: 2 });
  d = decideEnd({ missCount: d.missCount, msSinceChatOk: stale });
  assert.equal(d.action, 'close');
  assert.equal(d.missCount, 0, 'close resets for the next stream');
  assert.equal(END_MISS_THRESHOLD, 3, 'the pre-existing 3-miss debounce is preserved');
});

test('non-api read modes are unchanged: an unmeasured chat never holds', () => {
  // lastPollOkAt 0 → caller passes a huge elapsed value.
  const d = decideEnd({ missCount: 0, msSinceChatOk: Number.MAX_SAFE_INTEGER });
  assert.equal(d.action, 'count');
});

// watcherVote — ADR 0133: liveness and chat-reading are two decisions. The chat page stays open
// for YouTube's ~5-minute tail (goodbyes are heard), but a confident "offline" from YouTube is not
// read as live while it does. Task 4: the vote is an Observation for the state model, and a certain
// end (the known video's own page answering not-live, or the Data API) says so. One test per row.

const VID = 'abcdefghijk';
const START = Date.parse('2026-10-24T20:00:00Z');
const look = (state, o = {}) => ({ state, videoId: '', certain: false, evidence: 'yt-reader', scheduledStart: null, ...o });

test('watcherVote row 1: live, any holding → live, not certain, the lookup\'s evidence, key = its video', () => {
  for (const holding of [true, false]) {
    assert.deepEqual(watcherVote({ lookup: look('live', { videoId: VID, evidence: 'is-live' }), holding }),
      { raw: 'live', certain: false, key: VID, evidence: 'is-live', scheduledStart: null }, `holding=${holding}`);
  }
});

test('watcherVote row 2: offline, certain (the known video answered not-live), any holding → offline, certain — the tail is read, not live', () => {
  for (const holding of [true, false]) {
    assert.deepEqual(watcherVote({ lookup: look('offline', { certain: true, evidence: 'not-live' }), holding }),
      { raw: 'offline', certain: true, key: '', evidence: 'not-live', scheduledStart: null }, `holding=${holding}`);
  }
});

test('watcherVote row 3: offline, uncertain (/live showed the channel page), any holding → offline, not certain', () => {
  for (const holding of [true, false]) {
    assert.deepEqual(watcherVote({ lookup: look('offline', { evidence: 'channel-canonical' }), holding }),
      { raw: 'offline', certain: false, key: '', evidence: 'channel-canonical', scheduledStart: null }, `holding=${holding}`);
  }
});

test('watcherVote row 4: upcoming, any holding → upcoming (never live), evidence upcoming, its start carried', () => {
  for (const holding of [true, false]) {
    assert.deepEqual(watcherVote({ lookup: look('upcoming', { videoId: VID, evidence: 'api-confirmed', scheduledStart: START }), holding }),
      { raw: 'upcoming', certain: false, key: VID, evidence: 'upcoming', scheduledStart: START }, `holding=${holding}`);
  }
});

test('watcherVote row 5: unknown while a live broadcast\'s chat page is open → live, held-by-chat (the degraded-lookup hold, kept)', () => {
  assert.deepEqual(watcherVote({ lookup: look('unknown', { evidence: 'sticky-check-failed' }), holding: true }),
    { raw: 'live', certain: false, key: '', evidence: 'held-by-chat', scheduledStart: null });
});

test('watcherVote row 6: unknown, not holding → unknown with the lookup\'s evidence, never offline', () => {
  assert.deepEqual(watcherVote({ lookup: look('unknown', { evidence: 'no-player-response' }), holding: false }),
    { raw: 'unknown', certain: false, key: '', evidence: 'no-player-response', scheduledStart: null });
});

// Task 1's six watcherVote pins, re-pinned to the Observation return (the same answers as before).
test('re-pin (Task 1): live, holding → live', () => {
  assert.equal(watcherVote({ lookup: look('live', { videoId: VID }), holding: true }).raw, 'live');
});
test('re-pin (Task 1): live, not holding → live', () => {
  assert.equal(watcherVote({ lookup: look('live', { videoId: VID }), holding: false }).raw, 'live');
});
test('re-pin (Task 1): offline while the chat tail is read → offline (the 0133 change)', () => {
  assert.equal(watcherVote({ lookup: look('offline'), holding: true }).raw, 'offline');
});
test('re-pin (Task 1): offline, chat closed → offline', () => {
  assert.equal(watcherVote({ lookup: look('offline'), holding: false }).raw, 'offline');
});
test('re-pin (Task 1): unknown while the chat page is open → live (the degraded-lookup hold, kept)', () => {
  assert.equal(watcherVote({ lookup: look('unknown'), holding: true }).raw, 'live');
});
test('re-pin (Task 1): unknown, chat closed → unknown, never offline', () => {
  assert.equal(watcherVote({ lookup: look('unknown'), holding: false }).raw, 'unknown');
});

// chatPlan — the waiting room (ADR 0133's split, 0134 E4): our own scheduled broadcast's countdown
// chat is read from YT_WAITING_ROOM_MS before its start; other channels' countdowns never are.
const MIN = 60_000;
const OTHER = 'zyxwvutsrqp';
const plan = (lookup, chatVideoId, relay, now = START) => chatPlan({ lookup, chatVideoId, relay, now });
const up = (minsAhead, id = VID) => look('upcoming', { videoId: id, scheduledStart: START + minsAhead * MIN });

test('YT_WAITING_ROOM_MS is 60 minutes (ADR 0134 E4, until k names a number)', () => {
  assert.equal(YT_WAITING_ROOM_MS, 60 * 60_000);
});

test('chatPlan row 1: live X, chat on another video (or none) → open X — home and relay alike', () => {
  for (const relay of [false, true]) {
    assert.deepEqual(plan(look('live', { videoId: VID }), OTHER, relay), { action: 'open', videoId: VID }, `relay=${relay}`);
    assert.deepEqual(plan(look('live', { videoId: VID }), null, relay), { action: 'open', videoId: VID }, `relay=${relay}, no page`);
  }
});

test('chatPlan row 2: live X, chat already on X → keep (the countdown page carries on into the live chat)', () => {
  for (const relay of [false, true]) assert.deepEqual(plan(look('live', { videoId: VID }), VID, relay), { action: 'keep' });
});

test('chatPlan row 3: our own upcoming X, start within 60 min, no page → open X (the countdown chat is read)', () => {
  assert.deepEqual(plan(up(60), null, false), { action: 'open', videoId: VID }, 'exactly 60 min ahead is inside');
  assert.deepEqual(plan(up(30), null, false), { action: 'open', videoId: VID });
  assert.deepEqual(plan(up(-5), null, false), { action: 'open', videoId: VID }, 'a late start is still inside');
});

test('chatPlan row 4: our own upcoming X, within 60 min, chat already on X → keep', () => {
  assert.deepEqual(plan(up(29), VID, false), { action: 'keep' });
});

test('chatPlan row 5: our own upcoming X more than 60 min ahead, no page → none (no headless page held open all day)', () => {
  assert.deepEqual(plan(up(61), null, false), { action: 'none' });
  assert.deepEqual(plan(up(24 * 60), null, false), { action: 'none' });
  assert.deepEqual(plan(look('upcoming', { videoId: VID, scheduledStart: null }), null, false), { action: 'none' }, 'no start time: never read');
});

test('chatPlan row 6: a relay\'s upcoming X → none: other channels\' countdowns are never read', () => {
  assert.deepEqual(plan(up(30), null, true), { action: 'none' });
  assert.deepEqual(plan(up(1), null, true), { action: 'none' });
});

test('chatPlan row 7: offline or unknown with a page open → keep (decideEnd alone closes it)', () => {
  for (const state of ['offline', 'unknown']) {
    for (const relay of [false, true]) assert.deepEqual(plan(look(state), VID, relay), { action: 'keep' }, `${state} relay=${relay}`);
  }
});

test('chatPlan row (review I1): upcoming X with its countdown open, then live on another video Y → open Y; the vote is live, key = Y', () => {
  const liveY = look('live', { videoId: OTHER, evidence: 'is-live-now' });
  assert.deepEqual(plan(liveY, VID, false), { action: 'open', videoId: OTHER });
  assert.deepEqual(decideWatch({ lookup: liveY, currentId: VID, missCount: 0, msSinceChatOk: 1, now: START }),
    { action: 'open', videoId: OTHER, missCount: 0 });
  assert.deepEqual(watcherVote({ lookup: liveY, holding: false }),
    { raw: 'live', certain: false, key: OTHER, evidence: 'is-live-now', scheduledStart: null });
});

test('chatPlan row 8: offline or unknown with no page → none', () => {
  for (const state of ['offline', 'unknown']) {
    for (const relay of [false, true]) assert.deepEqual(plan(look(state), null, relay), { action: 'none' }, `${state} relay=${relay}`);
  }
});

// decideWatch — the watcher tick's decision, pure so the journal replays drive the real one.
test('decideWatch: a new live id opens (naming it); the same id keeps watching; misses reset', () => {
  assert.deepEqual(decideWatch({ lookup: { state: 'live', videoId: 'v1' }, currentId: null, missCount: 2, msSinceChatOk: 1 }),
    { action: 'open', videoId: 'v1', missCount: 0 });
  assert.deepEqual(decideWatch({ lookup: { state: 'live', videoId: 'v1' }, currentId: 'v1', missCount: 2, msSinceChatOk: 1 }),
    { action: 'watch', missCount: 0 });
});

test('decideWatch: offline and unknown alike leave chat-closing to decideEnd (the tail is still read)', () => {
  for (const state of ['offline', 'unknown']) {
    const lookup = { state, videoId: '' };
    assert.deepEqual(decideWatch({ lookup, currentId: 'v1', missCount: 0, msSinceChatOk: 1_000 }), { action: 'hold', missCount: 0 }, state);
    assert.deepEqual(decideWatch({ lookup, currentId: 'v1', missCount: 0, msSinceChatOk: END_HOLD_MS }), { action: 'count', missCount: 1 }, state);
    assert.deepEqual(decideWatch({ lookup, currentId: 'v1', missCount: 2, msSinceChatOk: END_HOLD_MS }), { action: 'close', missCount: 0 }, state);
    assert.deepEqual(decideWatch({ lookup, currentId: null, missCount: 0, msSinceChatOk: 1 }), { action: 'watch', missCount: 0 }, state);
  }
});

test('decideWatch: the countdown — opens inside the window, keeps watching its page, never runs the end debounce on it', () => {
  assert.deepEqual(decideWatch({ lookup: up(30), currentId: null, missCount: 0, msSinceChatOk: 1, now: START }),
    { action: 'open', videoId: VID, missCount: 0 });
  assert.deepEqual(decideWatch({ lookup: up(29), currentId: VID, missCount: 1, msSinceChatOk: END_HOLD_MS * 10, now: START }),
    { action: 'watch', missCount: 0 }, 'a quiet countdown chat is not an end');
  assert.deepEqual(decideWatch({ lookup: up(90), currentId: null, missCount: 0, msSinceChatOk: 1, now: START }),
    { action: 'watch', missCount: 0 }, 'outside the window: nothing to open');
  assert.deepEqual(decideWatch({ lookup: up(30), currentId: null, missCount: 0, msSinceChatOk: 1, now: START, relay: true }),
    { action: 'watch', missCount: 0 }, 'a relay never opens a countdown');
});

// chatPollDelay — the countdown chat is read every COUNTDOWN_POLL_MS (2026-10-25: at YouTube's ~14.5 s
// timeoutMs a countdown line reached the site up to 15 s late); the 1 s self-poll starts at live.
test('chatPollDelay: live polls at the self-poll; a countdown every ~3 s whatever timeoutMs YouTube names', () => {
  assert.equal(COUNTDOWN_POLL_MS, 3000);
  assert.equal(chatPollDelay({ live: true, selfPollMs: 1000 }), 1000);
  assert.equal(chatPollDelay({ live: false, selfPollMs: 1000 }), 3000, 'a countdown no longer waits for timeoutMs');
  assert.equal(chatPollDelay({ live: false, selfPollMs: 5000 }), 5000, 'never faster than the self-poll');
  assert.ok(COUNTDOWN_POLL_MS < STALL_MS, 'a countdown poll always lands inside the stall watchdog\'s window');
});
