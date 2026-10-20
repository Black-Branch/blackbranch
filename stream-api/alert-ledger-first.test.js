// The ledger answers BEFORE anything fires on stream (R2-3), and a payment the
// ledger cannot price is kept, not lost (R2-1).
// Run: node --test alert-ledger-first.test.js
//
// R2-3: every on-stream effect — the overlay frame, the alert sound, the room
// lights, the TTS voice — and the chat card ran BEFORE the ledger said whether
// this event had already been recorded. The durable event_id dedup stopped the
// second bar credit, and nothing else: the same Streamlabs donation re-emitted
// on reconnect, or any retry bridging a restart (the in-memory guards empty),
// rang, flashed, spoke and posted a card a second time.
//
// R2-1: a payment in a currency with no rate converts to $0, and a $0 take-home
// wrote no ledger row at all — the money arrived, was celebrated, and left no
// trace to reconcile from. It now lands in stream.unpriced_support (via the
// `logUnpriced` dep), whose unique event_id is also its replay answer, and the
// alert shows the raw amount string instead of nothing.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlert } = require('./alert');

function rig({ ledger, unpriced, ledgerSlowMs, sleep } = {}) {
  const order = [];
  const n = { showAlert: 0, sound: 0, lights: 0, tts: 0, card: 0, persist: 0, bar: 0, ledger: 0, unpriced: 0 };
  const seen = new Set();
  const unpricedRows = [];
  const alert = createAlert({
    broadcast: (m) => {
      if (m.type === 'showAlert') { n.showAlert++; order.push('showAlert'); }
      if (m.type === 'message') n.card++;
    },
    bufferPush: () => {},
    obs: { playSound: async () => { n.sound++; order.push('sound'); } },
    lights: { flash: async () => { n.lights++; } },
    tts: { speak: () => { n.tts++; } },
    supportBar: { add: () => { n.bar++; order.push('bar'); return { deltaSeconds: 1 }; } },
    persistCard: async () => { n.persist++; return 7; },
    logSupport: ledger || (async ({ eventId }) => {
      n.ledger++; order.push('ledger');
      const dup = eventId != null && seen.has(eventId);
      if (eventId != null) seen.add(eventId);
      return { duplicate: dup, canonicalId: 'c1' };
    }),
    logUnpriced: unpriced || (async (row) => {
      n.unpriced++; order.push('unpriced');
      unpricedRows.push(row);
      const dup = row.eventId != null && seen.has(row.eventId);
      if (row.eventId != null) seen.add(row.eventId);
      return { duplicate: dup };
    }),
    ...(ledgerSlowMs != null ? { ledgerSlowMs } : {}),
    ...(sleep ? { sleep } : {}),
  });
  return { alert, n, order, unpricedRows };
}

const STREAMLABS = { platform: 'streamlabs', eventType: 'donation', username: 'casey', amount: 10,
  currency: 'USD', message: 'hello there', label: 'donated', eventId: 'sl-1', grossUSD: 10 };

test('the same event delivered twice fires everything ONCE', async () => {
  const { alert, n } = rig();
  await alert.dispatch(STREAMLABS);
  const second = await alert.dispatch(STREAMLABS);
  assert.deepEqual(
    { showAlert: n.showAlert, sound: n.sound, lights: n.lights, tts: n.tts, card: n.card, persist: n.persist, bar: n.bar },
    { showAlert: 1, sound: 1, lights: 1, tts: 1, card: 1, persist: 1, bar: 1 },
    'a duplicate delivery re-fired an on-stream effect or the chat card');
  assert.equal(second.deduped, true, 'dispatch must say it deduped');
});

test('the ledger is asked before any effect fires', async () => {
  const { alert, order } = rig();
  await alert.fireStreamEffects({ ...STREAMLABS, eventId: 'sl-2' });
  assert.equal(order[0], 'ledger', `effects ran before the ledger answered: ${order.join(' → ')}`);
  assert.ok(order.indexOf('bar') > order.indexOf('ledger'), 'the bar must still move only after the ledger row');
});

// L1 (owner rule): the celebration stays PENDING until the ledger confirms the event is new,
// then fires once — however late. Never blind, no ceiling.
test('a slow ledger HOLDS the celebration: nothing fires until it answers, then everything fires once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const warned = [];
  const quiet = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  const { alert, n } = rig({ ledgerSlowMs: 20, ledger: async () => { await gate; return { duplicate: false }; } });
  let out;
  try {
    const p = alert.fireStreamEffects({ ...STREAMLABS, eventId: 'sl-3' });
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual({ showAlert: n.showAlert, sound: n.sound, lights: n.lights, tts: n.tts, bar: n.bar },
      { showAlert: 0, sound: 0, lights: 0, tts: 0, bar: 0 }, 'an effect fired before the ledger said the event is new');
    assert.ok(warned.some((w) => /has not answered/.test(w) && w.includes('sl-3')), 'a slow ledger must be logged loudly');
    release();
    out = await p;
  } finally { console.warn = quiet; }
  assert.deepEqual({ showAlert: n.showAlert, sound: n.sound, lights: n.lights, tts: n.tts, bar: n.bar },
    { showAlert: 1, sound: 1, lights: 1, tts: 1, bar: 1 }, 'the held celebration must fire once the ledger answers');
  assert.notEqual(out.duplicate, true);
});

test('a slow ledger that turns out to be a duplicate fires and credits nothing', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const quiet = console.warn;
  console.warn = () => {};
  let out;
  let n;
  try {
    const r = rig({ ledgerSlowMs: 20, ledger: async () => { await gate; return { duplicate: true }; } });
    n = r.n;
    const p = r.alert.fireStreamEffects({ ...STREAMLABS, eventId: 'sl-4' });
    await new Promise((res) => setTimeout(res, 60));
    release();
    out = await p;
  } finally { console.warn = quiet; }
  assert.deepEqual({ showAlert: n.showAlert, sound: n.sound, tts: n.tts, bar: n.bar }, { showAlert: 0, sound: 0, tts: 0, bar: 0 });
  assert.equal(out.duplicate, true);
});

test('a REJECTED ledger write is retried until it lands, then celebrates once and credits once', async () => {
  let attempts = 0;
  const slept = [];
  const errors = [];
  const qe = console.error;
  const qw = console.warn;
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = () => {};
  let r;
  try {
    r = rig({
      sleep: async (ms) => { slept.push(ms); },
      ledger: async () => { attempts++; if (attempts < 3) throw new Error('db down'); return { duplicate: false, canonicalId: 'c1' }; },
    });
    await r.alert.dispatch({ ...STREAMLABS, eventId: 'sl-5' });
  } finally { console.error = qe; console.warn = qw; }
  assert.equal(attempts, 3, 'a rejected write was not retried');
  assert.equal(slept.length, 2, 'each failure waits before the retry');
  assert.deepEqual({ showAlert: r.n.showAlert, card: r.n.card, bar: r.n.bar }, { showAlert: 1, card: 1, bar: 1 });
  assert.ok(errors.filter((e) => /FAILED/.test(e) && e.includes('sl-5')).length === 2, 'each failed attempt is logged by event id');
  assert.ok(errors.every((e) => !e.includes('casey')), 'a donor name reached a failure log line');
});

test('while the ledger keeps rejecting, nothing fires and the bar does not move', async () => {
  const errors = [];
  const qe = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let stop;
  const stopped = new Promise((res) => { stop = res; });
  let r;
  try {
    let tries = 0;
    r = rig({
      // The 4th wait never ends — the write is still being retried when we look.
      sleep: async () => { tries++; if (tries > 3) { stop(); await new Promise(() => {}); } },
      ledger: async () => { throw new Error('db down'); },
    });
    r.alert.fireStreamEffects({ ...STREAMLABS, eventId: 'sl-6' });
    await stopped;
  } finally { console.error = qe; }
  assert.deepEqual({ showAlert: r.n.showAlert, sound: r.n.sound, tts: r.n.tts, bar: r.n.bar },
    { showAlert: 0, sound: 0, tts: 0, bar: 0 }, 'a celebration fired blind while the ledger was refusing the write');
  assert.ok(errors.length >= 4, 'every failed attempt must be logged');
});

test('a retry that answers "already recorded" is treated as a duplicate (a failed attempt may have committed)', async () => {
  let attempts = 0;
  const warned = [];
  const qe = console.error;
  const qw = console.warn;
  console.error = () => {};
  console.warn = (...a) => warned.push(a.join(' '));
  let out;
  let r;
  try {
    r = rig({ sleep: async () => {}, ledger: async () => { attempts++; if (attempts === 1) throw new Error('reply lost'); return { duplicate: true }; } });
    out = await r.alert.fireStreamEffects({ ...STREAMLABS, eventId: 'sl-7' });
  } finally { console.error = qe; console.warn = qw; }
  assert.equal(out.duplicate, true);
  assert.equal(r.n.showAlert, 0);
  assert.ok(warned.some((w) => /treated as a duplicate/.test(w)), 'the ambiguous duplicate must be said in the journal');
});

// ── R2-1: unpriced ──────────────────────────────────────────────────────────

const ARS_LIKE = { platform: 'youtube', eventType: 'superchat', username: 'casey', amount: 5000,
  currency: 'UNKNOWN', amountText: 'F CFA 5,000', message: 'hola', label: 'super chat', eventId: 'youtube:r-1' };

test('an unpriceable payment is kept in unpriced_support — never the ledger, never the bar', async () => {
  const errors = [];
  const quiet = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let r;
  try {
    r = rig();
    await r.alert.dispatch(ARS_LIKE);
  } finally { console.error = quiet; }
  assert.equal(r.n.ledger, 0, 'an unpriced event reached stream.support_events');
  assert.equal(r.n.bar, 0, 'an unpriced event moved the bar');
  assert.equal(r.unpricedRows.length, 1, 'the unpriced payment left no row — it is lost');
  const row = r.unpricedRows[0];
  assert.equal(row.amountNative, 5000);
  assert.equal(row.currency, 'UNKNOWN');
  assert.equal(row.raw, 'F CFA 5,000');
  assert.equal(row.eventId, 'alert:youtube:youtube:r-1', 'the key must match the ledger\'s, so reconciliation is idempotent');
  assert.ok(errors.some((e) => e.includes('F CFA 5,000')), 'the raw string must be in a loud log line');
});

test('an unpriceable payment still celebrates, showing the raw amount — never "$0"', async () => {
  const frames = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const alert = createAlert({
      broadcast: (m) => frames.push(m), bufferPush: () => {}, obs: null, tts: null, supportBar: null,
      logSupport: async () => ({ duplicate: false }), logUnpriced: async () => ({ duplicate: false }),
    });
    await alert.dispatch(ARS_LIKE);
  } finally { console.error = quiet; }
  const show = frames.find((f) => f.type === 'showAlert');
  assert.ok(show, 'the overlay moment was lost');
  assert.equal(show.amount, 'F CFA 5,000');
  assert.ok(frames.some((f) => f.type === 'message'), 'the chat card was lost');
});

test('an unpriced event replayed fires nothing the second time', async () => {
  const quiet = console.error;
  console.error = () => {};
  let r;
  try {
    r = rig();
    await r.alert.dispatch(ARS_LIKE);
    await r.alert.dispatch(ARS_LIKE);
  } finally { console.error = quiet; }
  assert.deepEqual({ showAlert: r.n.showAlert, sound: r.n.sound, card: r.n.card },
    { showAlert: 1, sound: 1, card: 1 });
});

test('the loud UNPRICED line goes out once per event, not once per replay', async () => {
  const errors = [];
  const quiet = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = rig();
    await r.alert.dispatch(ARS_LIKE);
    await r.alert.dispatch(ARS_LIKE);
    await r.alert.dispatch(ARS_LIKE);
  } finally { console.error = quiet; }
  assert.equal(errors.filter((e) => /UNPRICED payment/.test(e)).length, 1, 'a replayed unpriced event re-announced (and re-pushed) itself');
});

test('a priced zero (a tip under the fee, a milestone) is NOT unpriced', async () => {
  const r = rig();
  await r.alert.dispatch({ platform: 'youtube', eventType: 'membership-milestone', username: 'casey', label: 'member', eventId: 'm1' });
  await r.alert.dispatch({ platform: 'streamlabs', eventType: 'donation', username: 'casey', amount: 0.2, currency: 'USD', eventId: 'sl-tiny' });
  assert.equal(r.unpricedRows.length, 0);
  assert.equal(r.n.showAlert, 2);
});

// ── R2-2's stream-api half ──────────────────────────────────────────────────

test('a gift with an unverified count is logged and credited 1, never 0', async () => {
  const warned = [];
  const quiet = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  const credited = [];
  try {
    const alert = createAlert({
      broadcast: () => {}, bufferPush: () => {}, obs: null, tts: null,
      supportBar: { add: (v) => { credited.push(v); return { deltaSeconds: 0 }; } },
      logSupport: async () => ({ duplicate: false }),
    });
    await alert.dispatch({ platform: 'youtube', eventType: 'membership-gift', username: 'casey', count: 1,
      countUnverified: true, label: 'gifted 1 membership', eventId: 'g1' });
  } finally { console.warn = quiet; }
  assert.equal(credited.length, 1);
  assert.ok(credited[0] > 0, 'an unverified gift credited nothing');
  assert.ok(warned.some((w) => /unverified/i.test(w) && w.includes('g1') && !w.includes('casey')), 'the unverified count was not logged');
});

// ── A write that can never succeed must not hold the money path forever ───────
// (security review of L1): a permanent error is not retried, a transient one is retried a
// bounded number of times; either way the event is recorded for reconciliation, nothing fires,
// and dispatch rejects so every caller answers non-2xx / forgets its replay key.

const { LedgerWriteError, isTransientDbError } = require('./alert');
const pgError = (code, message = 'boom') => Object.assign(new Error(message), { code });

test('isTransientDbError: connection/serialization/deadlock retry; data and constraint errors do not', () => {
  for (const c of ['08006', '08001', '40001', '40P01', '57P01', '57014', '53300', '55P03']) assert.equal(isTransientDbError(pgError(c)), true, c);
  for (const c of ['22021', '22001', '22003', '23505', '23502', '42P01']) assert.equal(isTransientDbError(pgError(c)), false, c);
  assert.equal(isTransientDbError(new Error('connect ECONNREFUSED')), true, 'a network error has no SQLSTATE and is retried');
});

function failingRig(ledger, extra = {}) {
  const recorded = [];
  const r = rig({ sleep: async () => {}, ledger, unpriced: async (row) => { recorded.push(row); return { duplicate: false }; }, ...extra });
  return { ...r, recorded };
}

test('a permanent (class 23) error: ONE attempt, recorded as ledger_failed, nothing fires, dispatch rejects', async () => {
  let attempts = 0;
  const h = failingRig(async () => { attempts++; throw pgError('23505', 'duplicate key value violates unique constraint'); });
  const qe = console.error;
  console.error = () => {};
  let err;
  try { await h.alert.dispatch({ ...STREAMLABS, eventId: 'sl-perm' }); } catch (e) { err = e; } finally { console.error = qe; }
  assert.ok(err instanceof LedgerWriteError, 'dispatch must reject so the caller answers non-2xx');
  assert.equal(err.permanent, true);
  assert.equal(err.recorded, true);
  assert.equal(attempts, 1, 'a permanent error was retried');
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].reason, 'ledger_failed');
  assert.equal(h.recorded[0].eventId, 'alert:streamlabs:sl-perm');
  assert.equal(h.recorded[0].currency, 'USD');
  assert.ok(h.recorded[0].amountNative > 0, 'the record must carry the take-home to reconcile');
  assert.deepEqual({ showAlert: h.n.showAlert, sound: h.n.sound, tts: h.n.tts, card: h.n.card, bar: h.n.bar },
    { showAlert: 0, sound: 0, tts: 0, card: 0, bar: 0 });
});

test('a transient error retries and then fires once', async () => {
  let attempts = 0;
  const h = failingRig(async () => { attempts++; if (attempts < 3) throw pgError('08006', 'connection failure'); return { duplicate: false }; });
  const qe = console.error;
  const qw = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { await h.alert.dispatch({ ...STREAMLABS, eventId: 'sl-trans' }); } finally { console.error = qe; console.warn = qw; }
  assert.equal(attempts, 3);
  assert.equal(h.recorded.length, 0);
  assert.deepEqual({ showAlert: h.n.showAlert, card: h.n.card, bar: h.n.bar }, { showAlert: 1, card: 1, bar: 1 });
});

test('a transient error past the cap ends in the recorded path, nothing fires', async () => {
  let attempts = 0;
  const h = failingRig(async () => { attempts++; throw pgError('08006'); });
  const alert = createAlert({
    broadcast: (m) => { if (m.type === 'showAlert') h.n.showAlert++; }, bufferPush: () => {}, obs: null, tts: null,
    supportBar: { add: () => { h.n.bar++; return {}; } },
    logSupport: async () => { attempts++; throw pgError('08006'); },
    logUnpriced: async (row) => { h.recorded.push(row); return { duplicate: false }; },
    sleep: async () => {}, ledgerMaxAttempts: 4,
  });
  const qe = console.error;
  console.error = () => {};
  let err;
  try { await alert.dispatch({ ...STREAMLABS, eventId: 'sl-cap' }); } catch (e) { err = e; } finally { console.error = qe; }
  assert.ok(err instanceof LedgerWriteError);
  assert.equal(err.permanent, false);
  assert.equal(attempts, 4, 'the transient retry must be bounded');
  assert.equal(h.recorded.length, 1);
  assert.equal(h.recorded[0].reason, 'ledger_failed');
  assert.equal(h.n.showAlert, 0);
  assert.equal(h.n.bar, 0);
});

test('donor text is cleaned before the INSERT: control characters gone, length clamped', async () => {
  const rows = [];
  const r = rig({ ledger: async (row) => { rows.push(row); return { duplicate: false }; } });
  await r.alert.dispatch({ ...STREAMLABS, eventId: 'sl-nul', username: 'ca\u0000sey\u0007' + 'x'.repeat(500) });
  assert.equal(rows.length, 1);
  assert.ok([...rows[0].username].every((ch) => ch.codePointAt(0) >= 32), 'a control character reached the INSERT');
  assert.ok(rows[0].username.startsWith('ca sey '));
  assert.ok(rows[0].username.length <= 100);
});

test('a failed write with NO event id is never recorded (no key to stop a double credit) — the journal is the handle', async () => {
  const h = failingRig(async () => { throw pgError('23505'); });
  const errors = [];
  const qe = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let err;
  try { await h.alert.dispatch({ ...STREAMLABS, eventId: undefined }); } catch (e) { err = e; } finally { console.error = qe; }
  assert.ok(err instanceof LedgerWriteError);
  assert.equal(err.recorded, false);
  assert.equal(h.recorded.length, 0, 'a key-less failure record could be reconciled AND delivered again');
  assert.ok(errors.some((e) => /UNRECORDED payment/.test(e)), 'the manual-handling line is missing');
  assert.ok(errors.every((e) => !e.includes('casey')));
});
