// Tests for buildEmoteMap's code-point indexing.
//
// Twitch's IRC `emotes` tag gives ranges in CODE POINTS. JS string indexing is
// in UTF-16 code units. Any astral character earlier in the message (every
// standard emoji is one) is 2 code units but 1 code point, so a raw .slice()
// drifts +1 per emoji and lifts the wrong substring. The result becomes the KEY
// of the {name:url} map, which the website matches against the tokens in the
// message — so a skewed key means the emote silently renders as plain text.
//
// Run: node --test platforms/twitchEmoteMap.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmoteMap } from './twitch.js';

const CDN = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`;
const names = (m) => Object.keys(m);

test('no emoji: plain ASCII is unaffected', () => {
  // "Kappa hello" — Kappa at code points 0-4.
  const m = buildEmoteMap({ emotes: { 25: ['0-4'] } }, 'Kappa hello');
  assert.deepEqual(names(m), ['Kappa']);
  assert.equal(m.Kappa, CDN(25));
});

test('THE BUG: one emoji before the emote', () => {
  // "👋 Kappa" — Twitch reports Kappa at 2-6 (code points).
  // A UTF-16 slice(2, 7) would yield " Kapp".
  const raw = '👋 Kappa';
  assert.equal(raw.slice(2, 7), ' Kapp', 'precondition: the naive slice really is wrong');
  const m = buildEmoteMap({ emotes: { 25: ['2-6'] } }, raw);
  assert.deepEqual(names(m), ['Kappa']);
});

test('skew grows with each astral char', () => {
  // "👋🎉👍 Kappa" — three emoji, so Kappa starts at code point 4.
  const raw = '👋🎉👍 Kappa';
  const m = buildEmoteMap({ emotes: { 25: ['4-8'] } }, raw);
  assert.deepEqual(names(m), ['Kappa']);
});

test('emote BEFORE the emoji still works (the case that never broke)', () => {
  const m = buildEmoteMap({ emotes: { 25: ['0-4'] } }, 'Kappa 👋');
  assert.deepEqual(names(m), ['Kappa']);
});

test('multiple emotes with emoji interleaved', () => {
  // "👋 Kappa 🎉 PogChamp"
  //  0:👋 1:' ' 2-6:Kappa 7:' ' 8:🎉 9:' ' 10-17:PogChamp
  const raw = '👋 Kappa 🎉 PogChamp';
  const m = buildEmoteMap({ emotes: { 25: ['2-6'], 88: ['10-17'] } }, raw);
  assert.deepEqual(names(m).sort(), ['Kappa', 'PogChamp']);
  assert.equal(m.Kappa, CDN(25));
  assert.equal(m.PogChamp, CDN(88));
});

test('non-emoji astral characters skew too', () => {
  // Mathematical bold capital A (U+1D400) is astral but not an emoji.
  const raw = '𝐀 Kappa';
  const m = buildEmoteMap({ emotes: { 25: ['2-6'] } }, raw);
  assert.deepEqual(names(m), ['Kappa']);
});

test('BMP multi-byte characters (e.g. CJK) were never skewed and still are not', () => {
  // 名 and 前 are each 1 code point AND 1 UTF-16 unit — multi-BYTE in UTF-8, but
  // that is irrelevant here. "名前Kappa" puts Kappa at 2-6 under either
  // indexing, so this case must stay correct.
  const m = buildEmoteMap({ emotes: { 25: ['2-6'] } }, '名前Kappa');
  assert.deepEqual(names(m), ['Kappa']);
});

test('only the first range is used, matching prior behaviour', () => {
  // The same emote repeated: Twitch lists every occurrence; one URL covers all.
  const m = buildEmoteMap({ emotes: { 25: ['0-4', '6-10'] } }, 'Kappa Kappa');
  assert.deepEqual(names(m), ['Kappa']);
});

test('degenerate inputs return an empty map rather than throwing', () => {
  assert.deepEqual(buildEmoteMap(null, 'hi'), {});
  assert.deepEqual(buildEmoteMap({ emotes: null }, 'hi'), {});
  assert.deepEqual(buildEmoteMap({ emotes: { 25: ['0-4'] } }, ''), {});
  assert.deepEqual(buildEmoteMap({ emotes: { 25: [] } }, 'Kappa'), {});
  assert.deepEqual(buildEmoteMap({ emotes: { 25: ['bad'] } }, 'Kappa'), {});
});

test('a range past the end of the message yields nothing, not a crash', () => {
  assert.deepEqual(buildEmoteMap({ emotes: { 25: ['50-60'] } }, 'Kappa'), {});
});
