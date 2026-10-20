// Pins parseWatchingNow — the strict parser over InnerTube updated_metadata's
// viewership renderer (the zero-quota primary viewer source).
// Run: node --test platforms/watchingNow.test.js
//
// The endpoint is unofficial, so the contract under test is REFUSAL: any shape
// that is not certain must return null, which sends lib/poller.js to the
// paid videos.list fallback. A wrong number here goes straight into
// stream.viewer_snapshots.youtube and therefore into the site's TOTAL viewer
// count — null never does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWatchingNow } from './youtube.js';

const viewership = (renderer) => ({
  actions: [
    { updateDateTextAction: {} },                       // real responses lead with these
    { updateViewershipAction: { viewCount: { videoViewCountRenderer: renderer } } },
    { updateTitleAction: {} },
  ],
});

test('parses the live shape observed in production (runs + commas)', () => {
  // Captured from a real live stream.
  const j = viewership({
    viewCount: { runs: [{ text: '6,433' }, { text: ' watching now' }] },
    isLive: true,
  });
  assert.equal(parseWatchingNow(j), 6433);
});

test('parses the simpleText variant and plain digits', () => {
  const j = viewership({ viewCount: { simpleText: '87 watching now' }, isLive: true });
  assert.equal(parseWatchingNow(j), 87);
});

test('REFUSES an ended stream: isLive false means null, even with digits', () => {
  // After the stream ends the same renderer carries the CUMULATIVE total.
  const j = viewership({
    viewCount: { runs: [{ text: '123,456' }, { text: ' views' }] },
    isLive: false,
  });
  assert.equal(parseWatchingNow(j), null);
});

test('REFUSES isLive absent — an unset flag is not a live stream', () => {
  const j = viewership({ viewCount: { simpleText: '99 watching now' } });
  assert.equal(parseWatchingNow(j), null);
});

test('REFUSES cumulative text even when isLive says true', () => {
  // Belt and suspenders: "views" must never parse as concurrent, whatever the
  // flag claims — both unofficial fields must agree.
  const j = viewership({ viewCount: { simpleText: '660,164,545 views' }, isLive: true });
  assert.equal(parseWatchingNow(j), null);
});

test('REFUSES abbreviated counts — "1.2K" must fall back, not parse as 1', () => {
  const j = viewership({ viewCount: { simpleText: '1.2K watching now' }, isLive: true });
  assert.equal(parseWatchingNow(j), null);
});

test('null on responses with no viewership action, or nothing at all', () => {
  assert.equal(parseWatchingNow({ actions: [{ updateTitleAction: {} }] }), null);
  assert.equal(parseWatchingNow({}), null);
  assert.equal(parseWatchingNow(null), null);
  assert.equal(parseWatchingNow(undefined), null);
});

test('null on a malformed renderer instead of throwing', () => {
  assert.equal(parseWatchingNow(viewership({})), null);
  assert.equal(parseWatchingNow(viewership({ isLive: true })), null);
  assert.equal(parseWatchingNow(viewership({ viewCount: { runs: 'junk' }, isLive: true })), null);
});
