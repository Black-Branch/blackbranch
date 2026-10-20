// The relay by which the OTHER process reaches a human — driven through the real
// handler, not scanned for.
//
// WHY THIS ROUTE EXISTS. stream-ingest holds no notifier of its own; without this relay
// its failures end in a console.warn in a journal nobody reads. One notifier is shared
// rather than duplicated so there is ONE rate limiter and ONE place to mute.
//
// WHAT THIS FILE IS REALLY GUARDING. A relay is a hole in the no-payload-values
// rule that notify.js's header states: an in-process caller has read that header,
// a remote caller has not. So the constraint has to be enforced, not documented,
// and these tests are what make it enforcement.
//
// Run: node --test ops-notify-route.test.js

'use strict';

// Before the require. notify.js reads its config at module load — setting these
// afterwards tests the DISABLED path, on which every assertion below passes
// vacuously. Same trap notify-wiring.test.js documents.
process.env.NTFY_WAKE_URL = 'https://ntfy.example/wake';
process.env.NTFY_QUIET_URL = 'https://ntfy.example/quiet';
process.env.OPS_NOTIFY_COOLDOWN_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerNotifyRoutes, enabled, _resetNotifyState, __test } = require('./notify.js');

const realFetch = global.fetch;

test('premise: the notifier is configured, so these assertions are not vacuous', () => {
  assert.equal(enabled(), true,
    'notify.js read its env as disabled — every assertion in this file would pass over nothing');
  assert.equal(typeof registerNotifyRoutes, 'function');
});

/**
 * Minimal Express stand-in: captures the one route the module registers, then
 * lets a test drive its handler directly. Booting the real app needs Postgres,
 * OBS, TTS and platform tokens, which is why money-policy.test.js is a scan —
 * but a single route's handler is importable, so this one need not be.
 */
function mountRoute() {
  let handler = null;
  let authed = false;
  const app = {
    post(path, ...rest) {
      if (path !== '/ops/notify') return;
      authed = rest.length > 1;
      handler = rest[rest.length - 1];
    },
  };
  registerNotifyRoutes(app, {
    requireInternal: (_req, _res, next) => next(),
    // The real `wrap` catches async throws; the identity is enough here and any
    // throw surfaces as a failed test rather than a swallowed 500.
    wrap: (fn) => fn,
  });
  assert.ok(handler, 'the route did not register');
  assert.ok(authed, '/ops/notify registered WITHOUT auth middleware');
  return handler;
}

/** Drive the handler; returns { status, body, sent } where `sent` is what ntfy got. */
async function call(body) {
  _resetNotifyState();
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://ntfy.example/')) sent.push({
      url: String(url), title: init.headers.Title,
      priority: init.headers.Priority, message: String(init.body),
    });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let status = 200;
  let payload = null;
  const res = {
    status(c) { status = c; return res; },
    json(b) { payload = b; return res; },
  };
  try {
    await mountRoute()({ body }, res);
  } finally {
    global.fetch = realFetch;
  }
  await new Promise((r) => setTimeout(r, 10)); // the send is fire-and-forget
  return { status, body: payload, sent };
}

test('a well-formed relay reaches ntfy and answers 202', async () => {
  const { status, sent } = await call({
    key: 'ingest.impressions-failing',
    title: 'Gadget impressions failing',
    message: '5 consecutive write failures — no success since boot',
  });
  assert.equal(status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Gadget impressions failing');
  assert.match(sent[0].message, /5 consecutive write failures/);
});

test('the answer is 202 regardless — a guard path must never branch on delivery', async () => {
  // The tempting design is to await notify() and report its boolean. That would
  // invite the caller to retry or to log a second failure when a phone is simply
  // out of signal — putting a second failure on top of the one being reported.
  _resetNotifyState();
  global.fetch = async () => { throw new Error('ntfy unreachable'); };
  let status = 0;
  const res = { status(c) { status = c; return res; }, json() { return res; } };
  try {
    await mountRoute()({ body: { key: 'ops.probe', title: 't', message: 'm' } }, res);
  } finally {
    global.fetch = realFetch;
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(status, 202, 'an unreachable ntfy must not become the caller’s problem');
});

test('a malformed key is refused — the key is the dedup unit, not free text', async () => {
  // A key that interpolates a user id would grow the rate-limiter table without
  // bound in a process that runs for weeks, and would defeat the cooldown
  // entirely: every message would be its own key and nothing would ever batch.
  for (const key of [
    'Ingest.Bad',                      // uppercase
    'x',                               // too short
    'a'.repeat(61),                    // too long
    'ingest impressions',              // space
    'ingest/../../etc',                // path-ish
    '',                                // empty
    42,                                // not a string
    { key: 'nested' },
  ]) {
    const { status, sent } = await call({ key, title: 't', message: 'm' });
    assert.equal(status, 400, `key ${JSON.stringify(key)} should have been refused`);
    assert.equal(sent.length, 0, `key ${JSON.stringify(key)} reached ntfy anyway`);
  }
});

test('a missing or non-string title/message is refused, not coerced', async () => {
  // `String(undefined)` would push the literal text "undefined" to a lock screen,
  // which is worse than nothing: it reads as a delivered alarm with no content.
  for (const body of [
    { key: 'ops.probe', title: 't' },
    { key: 'ops.probe', message: 'm' },
    { key: 'ops.probe', title: '', message: 'm' },
    { key: 'ops.probe', title: 't', message: '' },
    { key: 'ops.probe', title: 5, message: 'm' },
    { key: 'ops.probe', title: 't', message: { a: 1 } },
    {},
  ]) {
    const { status, sent } = await call(body);
    assert.equal(status, 400, `${JSON.stringify(body)} should have been refused`);
    assert.equal(sent.length, 0);
  }
});

test('an oversized title/message is TRUNCATED, so a leak is bounded even if a caller misbehaves', async () => {
  // Truncation rather than rejection is deliberate. A remote caller that has
  // not read the no-payload-values rule should still get its alarm through —
  // losing the alarm to punish the caller is the wrong trade — but a lock screen
  // must never render an unbounded body.
  const { status, sent } = await call({
    key: 'ops.probe',
    title: 'T'.repeat(500),
    message: 'M'.repeat(5000),
  });
  assert.equal(status, 202);
  assert.equal(sent[0].title.length, __test.MAX_TITLE);
  assert.equal(sent[0].message.length, __test.MAX_MESSAGE);
});

test('a body that is absent entirely does not throw', async () => {
  // express.json() leaves req.body undefined on a bodyless POST. A throw here
  // would be a 500 on the ops path — noise that looks like the incident.
  const { status } = await call(undefined);
  assert.equal(status, 400);
});
