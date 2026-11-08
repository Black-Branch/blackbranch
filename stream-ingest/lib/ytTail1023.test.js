// Journal replays of the two nights YouTube's chat tail held the stream open (ADR 0133).
//
// 2026-10-23 (stream-ingest journal, read 2026-10-24): OBS closed 09:58:01 UTC; the reader's /live
// lookup answered not-live from 09:58:42 ("live lookup failing but chat is delivering — holding
// open"); the chat continuation last delivered at 10:03:12 (the 10:04:13 cadence line says
// "lastOk=61s ago"); the reader closed the chat at 10:06:12; the poller printed youtube=live until
// 10:05:55 and ended the night at 10:07:55 — 9 min 54 s after OBS.
// 2026-10-24: not-live from 08:36:06, chat last delivered 08:40:58 ("lastOk=35s ago" at 08:41:33),
// chat closed 08:43:36, youtube=live in every poller line until then; k forced the end at 08:41:29.
//
// The replay drives the watcher's real decision (decideWatch → decideEnd) and vote (watcherVote) at
// the watcher's 30 s ticks, and feeds the vote through the poller's real youtubeReading,
// youtubeObservation and state model (lib/platformState.js: an uncertain offline on its second
// answered reading) at the poller's real tick times. The other platforms' columns are the journal's
// own (already debounced) `platform states` values. No tokens or viewer names are in this file.
//
// Break-verify is built in: the same replay with watcherVote's offline+holding row reverted to `live`
// must reproduce the journal as it happened (youtube=live until the chat closed).
//
// Run: node --test lib/ytTail1023.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.YT_INNERTUBE_VIEWERS;
delete process.env.YOUTUBE_VIDEO_ID;
const { decideWatch, watcherVote } = await import('./ytEndDecision.js');
const { youtubeReading, youtubeObservation, aggregateLiveness } = await import('./poller.js');
const { platformState, voteOf } = await import('./platformState.js');

const CH = 'UCcaseytestchannel00000';
const VID = 'abcdefghijk';
const at = (day, hms) => Date.parse(`2026-10-${day}T${hms}Z`);
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);

// The vote as it was before 0133: a tail being read reads live.
const voteBefore0133 = (o) => (o.lookup.state === 'offline' && o.holding ? { ...watcherVote(o), raw: 'live', certain: false } : watcherVote(o));

/**
 * Run one night.
 * @param {object} night
 * @param {number[]} night.watcherTicks   the reader's lookup ticks (30 s apart)
 * @param {number}   night.offlineFrom    first tick whose lookup answered not-live
 * @param {number}   night.chatLastOk     the last chat poll that delivered
 * @param {Array<[number, object]>} night.pollerTicks  [time, the other platforms' journal states]
 * @param {Function} vote                 watcherVote or a mutant
 */
async function replay(night, vote) {
  const watcher = [];
  let currentId = VID; // the chat page was open on the broadcast all night
  let missCount = 0;
  for (const t of night.watcherTicks) {
    // The journal cannot tell which path answered not-live, so the end is modelled as Task 1 did: an
    // UNCERTAIN offline (two answered readings). Certain ends are lib/pollerReplay.test.js's.
    const lookup = t < night.offlineFrom
      ? { state: 'live', videoId: VID, certain: false, evidence: 'is-live', scheduledStart: null }
      : { state: 'offline', videoId: '', certain: false, evidence: 'channel-canonical', scheduledStart: null };
    const d = decideWatch({ lookup, currentId, missCount, msSinceChatOk: t - Math.min(t, night.chatLastOk), now: t });
    missCount = d.missCount;
    if (d.action === 'open') currentId = lookup.videoId;
    if (d.action === 'close') currentId = null;
    const v = vote({ lookup, holding: currentId != null });
    watcher.push({ t, action: d.action, open: currentId != null, vote: v.raw, state: v, videoId: v.raw === 'live' ? currentId : '' });
  }
  let ytState = null;
  const poller = [];
  for (const [t, others] of night.pollerTicks) {
    const w = watcher.filter((x) => x.t <= t).at(-1);
    const reading = await youtubeReading({ watcher: { ...w.state, videoId: w.videoId }, wanted: true, channelId: CH });
    ytState = platformState(ytState, youtubeObservation(reading, 'reader'), t);
    const youtube = ytState.state;
    const agg = aggregateLiveness(Object.entries({ ...others, youtube: voteOf(ytState) }).map(([name, state]) => ({ name, state })));
    poller.push({ t, youtube, videoId: reading.videoId, allOffline: agg.allConfirmedOffline });
  }
  return { watcher, poller };
}

const ticks = (from, to, stepMs = 30_000) => {
  const out = [];
  for (let t = from; t <= to; t += stepMs) out.push(t);
  return out;
};
const L = 'live', U = 'unknown', O = 'offline';
const os = (twitch, kick, streamplace) => ({ twitch, kick, streamplace });

const N1023 = {
  watcherTicks: ticks(at(23, '09:55:12'), at(23, '10:08:12')),
  offlineFrom: at(23, '09:58:42'),
  // "lastOk=61s ago" at 10:04:13. At whole seconds the 90 s hold ends exactly at the 10:04:42 tick.
  chatLastOk: at(23, '10:03:12'),
  pollerTicks: [
    [at(23, '09:56:53'), os(L, L, L)],
    [at(23, '09:57:53'), os(U, L, L)],
    [at(23, '09:58:53'), os(O, L, U)],
    [at(23, '09:59:53'), os(O, U, O)],
    [at(23, '10:00:54'), os(O, O, O)],
    [at(23, '10:01:54'), os(O, O, O)],
    [at(23, '10:02:54'), os(O, O, O)],
    [at(23, '10:03:54'), os(O, O, O)],
    [at(23, '10:04:55'), os(O, O, O)],
    [at(23, '10:05:55'), os(O, O, O)],
    [at(23, '10:06:55'), os(O, O, O)],
    [at(23, '10:07:55'), os(O, O, O)],
  ],
};

// The journal's real stamps carry sub-second offsets: its close came at 10:06:12, one tick later,
// which the same code reproduces with the last good poll at 10:03:12.9.
const N1023_JOURNAL = { ...N1023, chatLastOk: at(23, '10:03:12') + 900 };

test('10-23: the vote reads offline from the first not-live lookup (09:58:42), while the chat page stays open', async () => {
  const { watcher } = await replay(N1023, watcherVote);
  const byT = (s) => watcher.find((w) => w.t === at(23, s));
  assert.equal(byT('09:58:12').vote, 'live');
  for (const w of watcher.filter((x) => x.t >= N1023.offlineFrom)) assert.equal(w.vote, 'offline', `vote at ${hms(w.t)}`);
  // Chat reading is unchanged: open through the tail, held for 90 s past the last good poll (to
  // 10:04:42), then three counted misses at 10:04:42, 10:05:12 and 10:05:42 — closed at 10:05:42.
  const actions = watcher.filter((x) => x.t >= N1023.offlineFrom && x.t <= at(23, '10:05:42')).map((w) => `${hms(w.t)} ${w.action}`);
  assert.deepEqual(actions, [
    '09:58:42 hold', '09:59:12 hold', '09:59:42 hold', '10:00:12 hold', '10:00:42 hold', '10:01:12 hold',
    '10:01:42 hold', '10:02:12 hold', '10:02:42 hold', '10:03:12 hold', '10:03:42 hold', '10:04:12 hold',
    '10:04:42 count', '10:05:12 count', '10:05:42 close',
  ]);
  assert.ok(watcher.filter((x) => x.t < at(23, '10:05:42')).every((w) => w.open), 'the tail is read: the page stays open until decideEnd closes it');
  assert.equal(byT('10:05:42').open, false);
});

test('10-23 with the journal\'s sub-second stamps: the same code closes the chat at 10:06:12, the journal\'s own line', async () => {
  const { watcher } = await replay(N1023_JOURNAL, watcherVote);
  assert.equal(hms(watcher.find((w) => w.action === 'close').t), '10:06:12');
});

test('10-23: through the poller\'s state model (two answered readings) YouTube reads offline at 09:59:53, and the night ends 10:00:54, not 10:07:55', async () => {
  const { poller } = await replay(N1023, watcherVote);
  const col = poller.map((p) => `${hms(p.t)} ${p.youtube}`);
  assert.deepEqual(col.slice(0, 4), ['09:56:53 live', '09:57:53 live', '09:58:53 unknown', '09:59:53 offline']);
  assert.ok(poller.filter((p) => p.t >= at(23, '09:59:53')).every((p) => p.youtube === 'offline'));
  assert.ok(poller.every((p) => p.youtube === 'live' || p.videoId === ''), 'no ended broadcast id rides a snapshot');
  assert.equal(hms(poller.find((p) => p.allOffline).t), '10:00:54', 'every platform confirmed offline 2 min 53 s after OBS closed');
});

test('10-23 break-verify: with the offline+holding row reverted to live, the replay reproduces the journal as it happened', async () => {
  const { poller } = await replay(N1023_JOURNAL, voteBefore0133);
  // The journal's youtube= column: live through 10:05:55, unknown 10:06:55, offline 10:07:55.
  assert.deepEqual(poller.map((p) => p.youtube), [L, L, L, L, L, L, L, L, L, L, U, O]);
  assert.equal(hms(poller.find((p) => p.allOffline).t), '10:07:55', 'the journal\'s own "stream ended" line');
});

const N1024 = {
  watcherTicks: ticks(at(24, '08:34:06'), at(24, '08:44:06')),
  offlineFrom: at(24, '08:36:06'),
  chatLastOk: at(24, '08:40:58'), // "lastOk=35s ago" at 08:41:33
  pollerTicks: [
    [at(24, '08:35:27'), os(L, L, L)],
    [at(24, '08:36:27'), os(U, L, U)],
    [at(24, '08:37:28'), os(O, L, O)],
    [at(24, '08:38:28'), os(O, U, O)],
    [at(24, '08:39:28'), os(O, O, O)],
    [at(24, '08:40:28'), os(O, O, O)],
  ],
};

test('10-24: the night ends by itself at 08:39:28, before k forced it at 08:41:29; the tail is still read until 08:43:36', async () => {
  const { watcher, poller } = await replay(N1024, watcherVote);
  assert.deepEqual(poller.map((p) => `${hms(p.t)} ${p.youtube}`).slice(0, 3), ['08:35:27 live', '08:36:27 unknown', '08:37:28 offline']);
  assert.equal(hms(poller.find((p) => p.allOffline).t), '08:39:28');
  assert.equal(hms(watcher.find((w) => w.action === 'close').t), '08:43:36', 'the journal\'s own "stream ended; closing chat"');
});

test('10-24 break-verify: before 0133 YouTube read live through the whole window, so nothing ended until k forced it', async () => {
  const { poller } = await replay(N1024, voteBefore0133);
  assert.ok(poller.every((p) => p.youtube === 'live'));
  assert.equal(poller.find((p) => p.allOffline), undefined);
});
