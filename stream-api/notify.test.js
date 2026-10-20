// Tests for notify.js — the operator-notification path.
//
// The properties that matter here are NOT "does a message arrive". They are the
// ones that decide whether this module can hurt the service it reports on:
//
//   1. It never throws and never rejects, whatever ntfy does.
//   2. It is off unless deliberately configured (one topic or two).
//   3. It rate-limits, and says what it swallowed.
//   4. Severity picks the TOPIC: critical → wake, everything else → quiet.
//
// (1) is the load-bearing one. Every call site is a guard path — the code that
// runs when something has ALREADY gone wrong — and several are fire-and-forget.
// A rejection there becomes an unhandledRejection and kills the process that was
// trying to tell you it had a problem.
//
// (4) is asserted on the REQUEST — url, headers and body — not on any internal
// value. A priority can be computed correctly and never reach the wire; the
// ambient-wash saturation bug proved that in this codebase already.
//
// Run: node --test notify.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const realFetch = global.fetch;

/** Load a fresh copy of notify.js under a given env.
 *
 *  The env STAYS applied until the next load(): the topic URLs are read at SEND time through
 *  the instance settings layer (a URL saved on the Credentials page must apply without a
 *  restart), so restoring the env right after require would test a module with no topics. */
let restorePrevious = () => {};
function load(env) {
  restorePrevious();
  const saved = {};
  // The HA keys stay in the clear-list although notify.js does not read them:
  // a dev machine with a real HA_TOKEN exported must not change what these
  // tests exercise.
  const keys = ['NTFY_WAKE_URL', 'NTFY_QUIET_URL', 'OPS_NOTIFY_ENABLED',
    'OPS_NOTIFY_COOLDOWN_MS', 'OPS_NOTIFY_TIMEOUT_MS',
    'HA_TOKEN', 'HA_URL', 'OPS_NOTIFY_TARGET'];
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./notify.js')];
  const mod = require('./notify.js');
  restorePrevious = () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
  return mod;
}

const CONFIGURED = {
  NTFY_WAKE_URL: 'https://ntfy.example/wake',
  NTFY_QUIET_URL: 'https://ntfy.example/quiet',
};

async function withFetch(impl, fn) {
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = realFetch; }
}

/** Capture every publish as { url, title, priority, tags, message }. */
async function capture(fn) {
  const sent = [];
  await withFetch(async (u, init) => {
    sent.push({
      url: String(u),
      title: init.headers.Title,
      priority: init.headers.Priority,
      tags: init.headers.Tags,
      message: String(init.body),
    });
    return { ok: true, status: 200 };
  }, fn);
  return sent;
}

// ── (1) it cannot hurt its caller ───────────────────────────────────────────

test('a thrown fetch resolves false — it never rejects', async () => {
  const { notify } = load(CONFIGURED);
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    // If this rejects, a guard path takes down stream-api while reporting a bug.
    assert.equal(await notify('k1', 't', 'm'), false);
  });
});

test('an HTTP error resolves false — it never rejects', async () => {
  const { notify } = load(CONFIGURED);
  await withFetch(async () => ({ ok: false, status: 429 }), async () => {
    assert.equal(await notify('k1', 't', 'm'), false);
  });
});

test('a hung ntfy cannot wedge the caller — the request carries a deadline', async () => {
  const { notify } = load({ ...CONFIGURED, OPS_NOTIFY_TIMEOUT_MS: '30' });
  await withFetch((_url, init) => new Promise((_resolve, reject) => {
    // Model AbortSignal.timeout firing on a socket that is accepted and then
    // never answered.
    init.signal.addEventListener('abort', () => reject(new Error('TimeoutError')));
  }), async () => {
    assert.equal(await notify('k1', 't', 'm'), false);
  });
});

test('an unawaited call with ntfy down produces no unhandled rejection', async () => {
  const { notify } = load(CONFIGURED);
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    await withFetch(async () => { throw new Error('down'); }, async () => {
      notify('k1', 't', 'm');                       // deliberately not awaited
      await new Promise((r) => setTimeout(r, 20));
    });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, [], 'a fire-and-forget notification rejected — that kills the service');
});

// ── (2) it ships disabled ───────────────────────────────────────────────────

test('no topic URLs means disabled, and no HTTP at all', async () => {
  const { notify, enabled } = load({});
  assert.equal(enabled(), false);
  await withFetch(async () => { throw new Error('should not be called'); }, async () => {
    assert.equal(await notify('k1', 't', 'm'), false);
  });
});

test('one topic is enough: both tiers go to it, and the priority still tells them apart', async () => {
  // A single topic is the common small install: one subscription on one phone. Severity still
  // rides the priority header (5 overrides Do Not Disturb, 3 does not), so nothing is misrouted —
  // there is only one place to route to.
  for (const env of [{ NTFY_WAKE_URL: 'https://ntfy.example/only' }, { NTFY_QUIET_URL: 'https://ntfy.example/only' }]) {
    const { notify, enabled } = load(env);
    assert.equal(enabled(), true, JSON.stringify(env));
    const sent = await capture(async () => {
      await notify('a', 'Money', 'clamped', { critical: true });
      await notify('b', 'Info', 'fyi');
    });
    assert.deepEqual(sent.map((x) => [x.url, x.priority]), [['https://ntfy.example/only', '5'], ['https://ntfy.example/only', '3']]);
  }
  assert.equal(load(CONFIGURED).enabled(), true);
});

test('OPS_NOTIFY_ENABLED=0 turns it off without unsetting the topic URLs', () => {
  assert.equal(load({ ...CONFIGURED, OPS_NOTIFY_ENABLED: '0' }).enabled(), false);
});

// ── (4) severity picks the topic, on the wire ───────────────────────────────

test('critical publishes to the WAKE topic at priority 5', async () => {
  const { notify } = load(CONFIGURED);
  const sent = await capture(() => notify('a', 'Money', 'clamped', { critical: true }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ntfy.example/wake',
    'a money-path failure at 3am must not land on the tier that waits for morning');
  assert.equal(sent[0].priority, '5');
  assert.equal(sent[0].tags, 'rotating_light');
});

test('non-critical publishes to the QUIET topic at priority 3', async () => {
  const { notify } = load(CONFIGURED);
  const sent = await capture(() => notify('b', 'Info', 'fyi'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://ntfy.example/quiet');
  assert.equal(sent[0].priority, '3');
  assert.equal(sent[0].tags, undefined, 'quiet pushes carry no attention-grabbing tag');
});

test('a trailing slash on a topic URL does not double', async () => {
  const { notify } = load({
    NTFY_WAKE_URL: 'https://ntfy.example/wake/',
    NTFY_QUIET_URL: 'https://ntfy.example/quiet/',
  });
  const sent = await capture(() => notify('a', 't', 'm', { critical: true }));
  assert.equal(sent[0].url, 'https://ntfy.example/wake');
});

test('a non-ASCII title is sanitized for the header; the body keeps its UTF-8', async () => {
  // undici refuses non-ASCII header values, and a refused header is a LOST
  // alert — the relay accepts arbitrary caller text, so this is enforced in
  // code, not assumed of callers.
  const { notify } = load(CONFIGURED);
  const sent = await capture(() => notify('a', 'árbol 🚨 down', 'körper 🚨 detail'));
  assert.match(sent[0].title, /^[\x20-\x7e]*$/, 'a non-ASCII header value loses the whole alert');
  assert.ok(sent[0].title.includes('down'), 'sanitizing must not destroy the readable part');
  assert.ok(sent[0].message.includes('körper 🚨'), 'the body is UTF-8-safe and must not be mangled');
});

// ── (3) it rate-limits, and reports what it swallowed ───────────────────────

test('a repeated key sends once per window', async () => {
  const { notify } = load({ ...CONFIGURED, OPS_NOTIFY_COOLDOWN_MS: '60000' });
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, status: 200 }; }, async () => {
    for (let i = 0; i < 50; i++) await notify('flood', 't', 'm');
  });
  assert.equal(calls, 1, 'a per-message guard would otherwise send a push per message, and get muted');
});

test('distinct keys are rate-limited independently', async () => {
  const { notify } = load({ ...CONFIGURED, OPS_NOTIFY_COOLDOWN_MS: '60000' });
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, status: 200 }; }, async () => {
    await notify('a', 't', 'm');
    await notify('b', 't', 'm');
    await notify('a', 't', 'm');
  });
  assert.equal(calls, 2, 'one noisy key must not silence a different, rarer failure');
});

test('the suppressed count rides the next push — nothing is silently dropped', async () => {
  const { notify } = load({ ...CONFIGURED, OPS_NOTIFY_COOLDOWN_MS: '25' });
  const sent = [];
  await withFetch(async (_u, init) => { sent.push(String(init.body)); return { ok: true, status: 200 }; },
    async () => {
      await notify('k', 'Take-home clamped', 'twitch/bits');
      for (let i = 0; i < 7; i++) await notify('k', 'Take-home clamped', 'twitch/bits');
      await new Promise((r) => setTimeout(r, 40));
      await notify('k', 'Take-home clamped', 'twitch/bits');
    });
  assert.equal(sent.length, 2);
  assert.equal(sent[0], 'twitch/bits', 'the first push carries no suppression tail');
  assert.match(sent[1], /^twitch\/bits \(\+7 more since \d\d:\d\d\)$/,
    'the second must account for the seven it swallowed, or the batching hides real volume');
});

test('the key table is bounded — a caller interpolating an id cannot grow it forever', async () => {
  const { gate } = load(CONFIGURED);
  for (let i = 0; i < 500; i++) gate(`user-${i}`, Date.now());
  // gate() is exported precisely so this is checkable without 500 HTTP calls.
  const { notify } = load({ ...CONFIGURED, OPS_NOTIFY_COOLDOWN_MS: '60000' });
  let calls = 0;
  await withFetch(async () => { calls++; return { ok: true, status: 200 }; }, async () => {
    for (let i = 0; i < 300; i++) await notify(`u-${i}`, 't', 'm');
    await notify('u-0', 't', 'm');   // evicted long ago -> allowed to send again
  });
  assert.equal(calls, 301, 'eviction costs at most one extra push; unbounded growth costs a leak');
});
