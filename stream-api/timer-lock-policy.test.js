// GUARD: lock-at-zero refuses TIME, never MONEY.
//
// When the marathon ends (lockAtZero + remaining 0), a donation must still
// credit the support bar and still write support_events — only the seconds are
// refused. The failure mode is SILENT: money would vanish from the ledger with
// no error anywhere.
//
// The ordering that makes this safe lives in supportbar.js: add() bumps and
// broadcasts the bar total BEFORE calling earnTime -> timer.addMoney. If the
// refusal is ever moved upstream of that, or turned into a throw, the money
// stops being banked. These tests pin both properties.
//
// Run: node --test timer-lock-policy.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimer } = require('./timer');
const { scanSource, at } = require('./testlib/source');

function drainedLockedTimer() {
  const t = createTimer({ broadcast: () => {}, obs: null, pool: null });
  t.setConfig({ lockAtZero: true });
  t.set('10s');
  t.adjust('10s', -1);
  return t;
}

test('a locked timer reports locked and adds no seconds', () => {
  const t = drainedLockedTimer();
  assert.equal(t.snapshot().locked, true);
  assert.equal(t.addMoney(250), 0, 'no time from a $250 donation while locked');
});

test('addMoney refusing time does NOT throw — the caller must reach its bank step', () => {
  // If the lock were a throw, supportbar.add()'s caller would unwind and the
  // support_events write after it would never run. It must return a number.
  const t = drainedLockedTimer();
  const applied = t.addMoney(100);
  assert.equal(typeof applied, 'number');
  assert.equal(applied, 0);
});

test('supportbar banks the money BEFORE consulting the timer', () => {
  // Structural: the bar total must be updated and broadcast before earnTime is
  // called, so a refusal downstream cannot cost a donation.
  const src = scanSource('supportbar.js', /module\.exports = \{ createSupportBar \}/);
  // `at` rather than raw indexOf: an ordering assertion on a -1 passes vacuously,
  // because -1 is less than every real index — deleting the bump being ordered
  // would leave this green.
  const bumpAt = at(src, 'total = round2(total + delta)');
  const earnAt = at(src, 'earnTime(delta)');
  assert.ok(
    bumpAt < earnAt,
    'supportbar.add() calls earnTime BEFORE banking the total — a locked timer ' +
    'would now cost the donation. Bank first, always.'
  );
});

test('the lock lives in timer.js and never in the money path', () => {
  // If supportbar or alert learn about lockAtZero, someone has moved the
  // refusal upstream of the bank.
  //
  // This is a NEGATIVE assertion, which is the one shape that goes GREEN over
  // a short read: absent-from-nothing is trivially true. A truncated
  // `supportbar.js` — or the money path moving to a third module — would report
  // the invariant HELD while nothing was checking it. `scanSource` refuses to return without proving the
  // read reached the end of the file.
  //
  // Reading raw would also be wrong in the other direction: a comment in
  // supportbar.js explaining *why* it must never consult lockAtZero would fail
  // this test. The scan measures the code, not the explanation.
  for (const [f, tail] of [
    ['supportbar.js', /module\.exports = \{ createSupportBar \}/],
    ['alert.js', /module\.exports = \{ createAlert, cleanForTTS,/],
  ]) {
    const src = scanSource(f, tail);
    assert.ok(
      !/lockAtZero/.test(src),
      `${f} references lockAtZero — the refusal must stay inside timer.addMoney(), ` +
      'downstream of the support-bar credit, or donations stop being banked'
    );
  }
});
