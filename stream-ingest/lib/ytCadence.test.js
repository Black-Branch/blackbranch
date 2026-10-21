// The YouTube "api cadence" heartbeat: judged every 30 s, printed healthy every 10 minutes.
// Run: node --test lib/ytCadence.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCadenceReporter } from './ytCadence.js';

const healthy = { ok: 30, txt: 2, dropText: 0, dropEvent: 0 };

test('an hour of healthy polling prints 6 lines (the first window, then one per ~10 min), not 116', () => {
  const r = createCadenceReporter({ now: 0 });
  const printed = [];
  let windows = 0;
  for (let t = 1_000; t <= 3_600_000; t += 1_000) {
    const due = r.check(t, healthy);
    if (!due) continue;
    windows += 1;
    assert.equal(due.stalled, null);
    assert.equal(due.dropped, false);
    if (due.healthy) printed.push(due.healthy);
  }
  assert.equal(windows, 116, 'still judged every 30 s');
  assert.equal(printed.length, 6);
  // The sums cover the whole stretch since the last line: 20 windows (of 31 s) of 30 polls.
  assert.deepEqual(printed[1], { counts: { ok: 600, txt: 40, dropText: 0, dropEvent: 0 }, windowS: 620 });
});

test('a window with no successful poll is reported at once — even right after a healthy line', () => {
  const r = createCadenceReporter({ now: 0 });
  assert.ok(r.check(31_000, healthy).healthy);
  const due = r.check(62_000, { ok: 0, txt: 0 });
  assert.deepEqual(due, { windowS: 31, stalled: { ok: 0, txt: 0 }, healthy: null, dropped: false });
});

test('discards are reported at once, beside a quiet healthy window', () => {
  const r = createCadenceReporter({ now: 0 });
  r.check(31_000, healthy);
  const due = r.check(62_000, { ok: 5, dropText: 2, dropEvent: 1 });
  assert.equal(due.dropped, true);
  assert.equal(due.healthy, null, 'the healthy line is not due yet');
});

test('inside a window nothing is decided (null), so the caller keeps counting', () => {
  const r = createCadenceReporter({ now: 0 });
  assert.equal(r.check(30_000, healthy), null);
});
