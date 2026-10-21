// One viewer snapshot's body — the live YouTube broadcast id rides along with
// the counts, so the site can embed the verified broadcast instead of
// `live_stream?channel=`, which lets YouTube guess.
//
// Run: node --test lib/pollerSnapshot.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { snapshotBody } from './poller.js';

const base = { streamId: '1700000000', twRaw: { state: 'live', viewers: 12 }, yt: 3, kickRaw: { viewers: null }, sp: 2 };

test('the confirmed live id is on the body, next to the counts', () => {
  const b = snapshotBody({ ...base, ytVideoId: 'dQw4w9WgXcQ' });
  assert.deepEqual(b, { streamId: '1700000000', twitch: 12, youtube: 3, kick: null, streamplace: 2, ytVideoId: 'dQw4w9WgXcQ' });
});

test('no confirmed id → null, never the empty string the poller caches', () => {
  assert.equal(snapshotBody({ ...base, ytVideoId: '' }).ytVideoId, null);
  assert.equal(snapshotBody({ ...base, ytVideoId: undefined }).ytVideoId, null);
});

test('the Twitch count rule is unchanged: offline or zero → null', () => {
  assert.equal(snapshotBody({ ...base, twRaw: { state: 'offline', viewers: 5 }, ytVideoId: '' }).twitch, null);
  assert.equal(snapshotBody({ ...base, twRaw: { state: 'live', viewers: 0 }, ytVideoId: '' }).twitch, null);
});

test('the tick hands snapshotBody the WATCHER\'s id, not the sticky viewer-count one', () => {
  // The module-level `ytVideoId` survives errors and two misses; shipping it
  // would embed an ended broadcast's archive at 0:00 while Twitch kept the
  // session open. Source pin, end-anchored.
  const src = readFileSync(fileURLToPath(new URL('./poller.js', import.meta.url)), 'utf8');
  assert.match(src, /export function startPoller\([\s\S]*\}\s*$/, 'read to the end of poller.js');
  // ytLiveId is this tick's VERIFIED id: the reader's own, or — with no reader running — the
  // poller's own lookup's (youtubeReading), never the sticky viewer-count one.
  assert.match(src, /snapshotBody\(\{ streamId, twRaw, yt: ytViewers, kickRaw, sp, ytVideoId: ytLiveId \}\)/);
  assert.match(src, /const ytLiveId = yt\?\.videoId \|\| '';/);
  assert.doesNotMatch(src, /postViewerSnapshot\(snapshotBody\(\{[^}]*\bytVideoId \}\)\)/, 'the call site must not pass the bare sticky id');
});
