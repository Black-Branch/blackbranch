'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEpisodeLog } = require('./episode-log');

// OBS is closed most of the day. The reconnect loop retries every 5 s — which
// is right, OBS should attach seconds after it opens — but logging every
// attempt would make it the biggest source of lines in the journal, burying
// real warnings.
// The cadence stays; the log speaks at the start of an outage, then rarely.

test('the first failure of an episode is logged, the repeats are not', () => {
  let t = 0;
  const ep = createEpisodeLog({ everyMs: 600_000, now: () => t });
  assert.deepEqual(ep.note(), { log: true, suppressed: 0 });
  t += 5000; assert.deepEqual(ep.note(), { log: false, suppressed: 1 });
  t += 5000; assert.deepEqual(ep.note(), { log: false, suppressed: 2 });
});

test('a long outage still reports, with how many attempts it swallowed', () => {
  let t = 0;
  const ep = createEpisodeLog({ everyMs: 600_000, now: () => t });
  ep.note();
  for (let i = 0; i < 119; i++) { t += 5000; assert.equal(ep.note().log, false); }
  t += 5000; // 600 s after the first line
  assert.deepEqual(ep.note(), { log: true, suppressed: 119 });
  t += 5000; assert.deepEqual(ep.note(), { log: false, suppressed: 1 });
});

test('recovery ends the episode: the next failure is a first failure again', () => {
  let t = 0;
  const ep = createEpisodeLog({ everyMs: 600_000, now: () => t });
  ep.note(); t += 5000; ep.note();
  assert.equal(ep.end(), true, 'there was an open episode to close');
  assert.equal(ep.end(), false, 'and only one');
  t += 5000;
  assert.deepEqual(ep.note(), { log: true, suppressed: 0 });
});

// The helper only matters where it is used: obs.js must ration its connect
// failures through it and close the episode when a connection succeeds.
test('obs.js rations its connect-failure log through an episode and ends it on connect', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'obs.js'), 'utf8');
  assert.match(src, /const connectLog = createEpisodeLog\(/);
  const end = src.indexOf('connectLog.end();');
  const ok = src.indexOf('console.log(`[obs] connected ${URL}`)');
  assert.ok(end > 0 && ok > end, 'a successful connect closes the episode');
  assert.match(src, /const \{ log, suppressed \} = connectLog\.note\(\);\s*if \(log\) \{/);
  assert.match(src, /module\.exports = \{[\s\S]*\};?\s*$/, 'scan reached the end of obs.js');
});
