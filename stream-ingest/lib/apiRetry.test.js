// postAlert's retry contract.
//
// With one attempt, a sub/cheer/superchat landing during a stream-api restart
// (the drain runs up to 10s) or one ECONNRESET would be gone forever — no
// support_events row, no bar credit, no on-stream alert. A run alarm cannot
// see a SINGLE lost event, so the money path retries.
//
// The contract:
//   • transient failures (network reject, 5xx) retry with backoff — legal
//     ONLY because /alert dedups on the payload's eventId, minted once by the
//     normalizer and resent verbatim;
//   • 4xx never retries — a rejected envelope does not get better, and
//     hammering the route just re-fires the producer-broken notify;
//   • exhausted retries still throw, so the caller's warn line still fires.
//
// Run: node --test lib/apiRetry.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { postAlert } from './api.js';
process.env.STREAM_API_URL ??= 'http://stream-api.test'; // no default (lib/streamApiUrl.js); fetch is stubbed

const ALERT = { platform: 'twitch', eventType: 'sub', eventId: 'twitch:msg-1', username: 'a' };
const ok = () => new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
const status = (code) => new Response('nope', { status: code });

test('a transient network failure is retried and delivers', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return ok();
  };
  const out = await postAlert(ALERT, { retryDelays: [1, 1] });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2, 'the failed attempt was not retried — that paid event is gone');
});

test('a 5xx is retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? status(503) : ok();
  };
  const out = await postAlert(ALERT, { retryDelays: [1, 1] });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls, 2);
});

test('a 4xx is NOT retried', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return status(400); };
  await assert.rejects(() => postAlert(ALERT, { retryDelays: [1, 1] }), /400/);
  assert.equal(calls, 1,
    'a rejected envelope was retried — it cannot get better, and each retry re-fires the notify');
});

test('exhausted retries still throw, so the caller\'s warn fires', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('fetch failed'); };
  await assert.rejects(() => postAlert(ALERT, { retryDelays: [1, 1] }), /fetch failed/);
  assert.equal(calls, 3, 'attempts = 1 + retryDelays.length');
});

test('every retry resends the SAME payload — the eventId is what makes this legal', async () => {
  const bodies = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    bodies.push(init.body);
    if (calls < 2) throw new TypeError('fetch failed');
    return ok();
  };
  await postAlert(ALERT, { retryDelays: [1] });
  assert.equal(bodies[0], bodies[1],
    'the retry rebuilt the payload — a fresh eventId per attempt defeats the dedup entirely');
});
