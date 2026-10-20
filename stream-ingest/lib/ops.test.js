// The run alarm — the shape every fire-and-forget guard in this process uses to
// reach a human.
//
// WHY A SHARED HELPER AND NOT THREE COPIES. Three call sites need the same
// judgement (a single failure is a blip, a run is an outage) and the same
// discipline (no payload values, never throws, reset on success). Three copies is
// three places for the reset to be forgotten — and forgetting the reset is not a
// tidiness problem, it is an alarm that fires about a healthy system after a
// week of unrelated blips, which gets the channel muted.
//
// Behavioural throughout: the alarm is a pure closure over a stubbed relay.
//
// Run: node --test lib/ops.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STREAM_API_URL = 'http://ops.test';

const { makeRunAlarm, notifyOps } = await import('./ops.js');

const realFetch = global.fetch;

/** Run `fn` with the relay stubbed; returns every body it tried to send. */
async function capture(fn) {
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).includes('/ops/notify')) sent.push(JSON.parse(init.body));
    return { ok: true, status: 202, json: async () => ({ ok: true }) };
  };
  try { await fn(); } finally { global.fetch = realFetch; }
  await new Promise((r) => setTimeout(r, 15)); // fire-and-forget
  return sent;
}

test('premise: the relay actually attempts a send', async () => {
  // Without this every "did not alarm" assertion below could be passing because
  // the relay is disabled or the URL is wrong, not because the logic held.
  const sent = await capture(() => notifyOps('ops.probe', 'title', 'message'));
  assert.equal(sent.length, 1, 'the relay never fired — every assertion here is vacuous');
});

test('below the threshold nothing is sent', async () => {
  const alarm = makeRunAlarm({ key: 'ops.test-run', title: 'T', after: 3 });
  const sent = await capture(() => { alarm.fail(); alarm.fail(); });
  assert.equal(sent.length, 0);
  assert.equal(alarm.state().consecutive, 2);
});

test('at the threshold it fires, and keeps firing while the run continues', async () => {
  // It deliberately does NOT fire once and go quiet. Going quiet would make an
  // ongoing outage indistinguishable from a resolved one. Flood control is
  // notify()'s per-key cooldown in stream-api, which is ONE place — not a second
  // suppression rule here that could disagree with it.
  const alarm = makeRunAlarm({ key: 'ops.test-run', title: 'T', after: 3 });
  const sent = await capture(() => { alarm.fail(); alarm.fail(); alarm.fail(); alarm.fail(); });
  assert.equal(sent.length, 2, 'expected a send on the 3rd and 4th failure');
  assert.equal(sent[0].key, 'ops.test-run');
  assert.match(sent[0].message, /^3 consecutive/);
  assert.match(sent[1].message, /^4 consecutive/);
});

test('a success resets the run — an intermittent fault must not creep to the threshold', async () => {
  // Without this, two failures a day apart eventually add up to an alarm about a
  // writer that is working. An alarm that cries wolf gets muted, and it takes the
  // real one with it.
  const alarm = makeRunAlarm({ key: 'ops.test-run', title: 'T', after: 3 });
  const sent = await capture(() => {
    alarm.fail(); alarm.fail(); alarm.ok();
    alarm.fail(); alarm.fail();
  });
  assert.equal(sent.length, 0);
  assert.equal(alarm.state().consecutive, 2);
});

test('after a success the message says how long ago it was, not "since boot"', async () => {
  const alarm = makeRunAlarm({ key: 'ops.test-run', title: 'T', after: 1 });
  const cold = await capture(() => alarm.fail());
  assert.match(cold[0].message, /no success since boot/);

  alarm.ok();
  const warm = await capture(() => alarm.fail());
  assert.match(warm[0].message, /last success \d+m ago/);
});

test('`after: 1` alarms immediately — for faults that cannot be a blip', async () => {
  // embeddings.js uses this: a wrong response SHAPE means the model changed and
  // will fail identically forever, so waiting for a run only delays the alarm.
  const alarm = makeRunAlarm({ key: 'ops.test-now', title: 'T', after: 1 });
  const sent = await capture(() => alarm.fail('got len 768, expected 1536'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /got len 768, expected 1536/);
});

test('a relay failure never rejects — the guard path must not be able to fail twice', async () => {
  // Every call site is un-awaited. A rejection here surfaces as an
  // unhandledRejection and takes down the process it was reporting on, which is
  // the precise shape of bug this module exists to make visible.
  global.fetch = async () => { throw new Error('stream-api unreachable'); };
  try {
    const alarm = makeRunAlarm({ key: 'ops.test-run', title: 'T', after: 1 });
    assert.doesNotThrow(() => alarm.fail());
    assert.equal(await notifyOps('ops.probe', 't', 'm'), false);
  } finally {
    global.fetch = realFetch;
  }
});

test('the relay is disableable without unsetting a shared credential', async () => {
  // Matches stream-api's own OPS_NOTIFY_ENABLED escape hatch, so ops can silence
  // both ends of the relay with one switch instead of pulling a token that
  // lights.js also uses.
  const prev = process.env.OPS_NOTIFY_ENABLED;
  process.env.OPS_NOTIFY_ENABLED = '0';
  try {
    const mod = await import(`./ops.js?disabled=${Date.now()}`);
    const sent = await capture(() => mod.notifyOps('ops.probe', 't', 'm'));
    assert.equal(sent.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OPS_NOTIFY_ENABLED;
    else process.env.OPS_NOTIFY_ENABLED = prev;
  }
});
