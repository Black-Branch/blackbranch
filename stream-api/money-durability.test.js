// The money mechanism's EDGES, beyond the retry-not-refund contract
// (/chat/event idempotency, /alert dedup):
//
//   • durable dedup — both dedup stores are IN-MEMORY, but the retries they
//     accept exist to bridge RESTARTS. So recordSupport dedups durably: an
//     `event_id` column on stream.support_events with a partial-unique index,
//     ON CONFLICT DO NOTHING, and "duplicate" answered to the caller so the
//     bar/timer are not credited twice either.
//   • a failed ledger write — for real money it pages (alert.js's logSupport
//     catch), not just logs.
//   • a DB error on sticker_boost's UPDATE is not a refusal: a settled 404
//     would make the web refund a boost whose overlay pop already fired. It
//     answers 503 and leaves the key in flight (unconfirmed, no refund).
//   • a throw between `spendOutcomes.set(key, null)` and the effects block
//     (buildEventCard) must release the key, or it stays in_flight for its
//     whole TTL; nothing has run yet at that point.
//
// Run: node --test money-durability.test.js

'use strict';

// Before the requires — notify.js reads its config at module load (see
// notify-wiring.test.js, same preamble for the same reason).
process.env.NTFY_WAKE_URL = 'https://ntfy.example/wake';
process.env.NTFY_QUIET_URL = 'https://ntfy.example/quiet';
process.env.OPS_NOTIFY_COOLDOWN_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney, makeRecordSupport } = require('./money.js');
const { NATIVE_PLATFORM } = require('./native-platform');
const { createAlert, buildEventCard } = require('./alert.js');
const { _resetNotifyState } = require('./notify.js');

const realFetch = global.fetch;

/** Run `fn` with HA stubbed; returns every notification body it received. */
async function captureNotifications(fn) {
  _resetNotifyState();
  const sent = [];
  global.fetch = async (url, init) => {
    if (String(url).startsWith('https://ntfy.example/')) sent.push({
      url: String(url), title: init.headers.Title,
      priority: init.headers.Priority, message: String(init.body),
    });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try { await fn(); } finally { global.fetch = realFetch; }
  await new Promise((r) => setTimeout(r, 10));
  return sent;
}

// ── harness (chat-event-idempotency.test.js's, + injectable card builder) ────

function harness({ poolQuery, ttsEnabled = true, sounds, cardBuilder } = {}) {
  const calls = [];
  const log = (fn, x) => { calls.push({ fn, ...x }); };
  const money = createMoney({
    pool: { query: poolQuery || (async () => ({ rows: [{}], rowCount: 1 })) },
    economics: {
      stripeNet: (usd) => usd * 0.83,
      formatUSD: (u) => `$${u.toFixed(2)}`,
    },
    alert: {
      buildEventCard: cardBuilder || buildEventCard,
      fireStreamEffects: async (args) => { log('fireStreamEffects', { args }); return { addedSeconds: 42 }; },
      dispatch: async () => {},
    },
    supportBar: { add: (usd, who) => { log('supportBar.add', { usd, who }); return { deltaSeconds: 7 }; }, reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return { usdPerHour: 0, fillUsd: 0 }; } },
    tts: { speak: (t) => log('tts.speak', { t }) },
    sounds: sounds || { play: async (id) => { log('sounds.play', { id }); return true; }, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async () => { log('persist', {}); return 999; },
    maskBlacklist: (t) => t,
    broadcast: (f) => log('broadcast', { type: f.type }),
    bufferPush: () => {}, bufferReplace: () => {},
    ttsEnabled: () => ttsEnabled,
  });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn }
  );
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/chat/event']({ body }, res);
    return res;
  };
  const credits = () => calls.filter((c) => ['recordSupport', 'supportBar.add', 'fireStreamEffects'].includes(c.fn));
  return { calls, post, credits };
}

const QUIET_CHEER = { kind: 'cheer', username: 'U', cheererMatrixId: '@u:l.io', coins: 100, message: 'hi' };

// ── durable dedup at the recordSupport chokepoint ───────────────────────────

test('recordSupport writes the event_id and answers "duplicate" on a conflict', async () => {
  const queries = [];
  let rowCount = 1;
  const rec = makeRecordSupport({
    pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: rowCount ? [{ id: 1 }] : [], rowCount }; } },
    resolveOrCreate: async () => 'canon-1',
    liveState: async () => ({ streamId: null }),
  });

  const first = await rec({ platform: NATIVE_PLATFORM, userId: '@u:l.io', username: 'U', amountUsd: 1, eventType: 'cheer', eventId: 'spend:cheer:s-1' });
  const insert = queries.find((q) => /INSERT INTO stream\.support_events/.test(q.sql));
  assert.ok(insert, 'no support_events insert ran');
  assert.match(insert.sql, /event_id/, 'the insert must carry the event_id column');
  assert.match(insert.sql, /ON CONFLICT/i, 'without ON CONFLICT a replayed id is an error, not a no-op');
  assert.ok(insert.params.includes('spend:cheer:s-1'), 'the eventId must reach the row');
  assert.equal(first.duplicate, false);
  assert.equal(first.canonicalId, 'canon-1');

  rowCount = 0; // the partial-unique index swallowed the insert — a replay
  const second = await rec({ platform: NATIVE_PLATFORM, userId: '@u:l.io', username: 'U', amountUsd: 1, eventType: 'cheer', eventId: 'spend:cheer:s-1' });
  assert.equal(second.duplicate, true,
    'a swallowed insert MUST be reported — the caller would otherwise credit the bar/timer a second time');
});

test('recordSupport without an eventId stays fail-open (NULL, no dedup)', async () => {
  const queries = [];
  const rec = makeRecordSupport({
    pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [{ id: 1 }], rowCount: 1 }; } },
    resolveOrCreate: async () => 'canon-1',
    liveState: async () => ({ streamId: null }),
  });
  const out = await rec({ platform: 'twitch', username: 'U', amountUsd: 2, eventType: 'donation' });
  assert.equal(out.duplicate, false);
  const insert = queries.find((q) => /INSERT INTO stream\.support_events/.test(q.sql));
  assert.ok(insert.params.includes(null), 'a missing eventId must insert NULL — the partial index then never dedups it');
});

// A coin spend never reaches recordSupport (currency spends credit nothing); the
// durable dedup is real money's path to the ledger, which the next test drives
// through alert.fireStreamEffects directly.

test('fireStreamEffects threads input.eventId into logSupport and honours "duplicate"', async () => {
  const logged = [];
  const barAdds = [];
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    supportBar: { add: (usd) => { barAdds.push(usd); return { deltaSeconds: 3 }; } },
    obs: null, tts: null, lights: null,
    logSupport: async (row) => { logged.push(row); return { canonicalId: 'c', duplicate: true }; },
    persistCard: async () => 1,
    maskBlacklist: (s) => s,
    timerLocked: () => false,
  });
  const r = await alert.fireStreamEffects({
    platform: 'twitch', eventType: 'donation', username: 'D', takeHomeUSD: 5,
    eventId: 'evt-77',
  });
  assert.equal(logged[0].eventId, 'alert:twitch:evt-77',
    'the ledger key must be platform-prefixed — the same raw id on two platforms is two events');
  assert.deepEqual(barAdds, [], 'a duplicate must not move the bar — the original delivery already did');
  assert.equal(r.addedSeconds, 0);
});

// ── a failed ledger write for real money must PAGE, not just log ────────────

test('a failed logSupport notifies, marked critical, with no username in the push', async () => {
  // The write is retried until it lands (alert.js); the first failure pages once.
  let attempts = 0;
  const alert = createAlert({
    broadcast: () => {}, bufferPush: () => {},
    supportBar: { add: () => ({ deltaSeconds: 1 }) },
    obs: null, tts: null, lights: null,
    sleep: async () => {},
    logSupport: async () => { if (++attempts < 3) throw new Error('connection terminated'); return { duplicate: false }; },
    persistCard: async () => 1,
    maskBlacklist: (s) => s,
    timerLocked: () => false,
  });
  const sent = await captureNotifications(() =>
    alert.fireStreamEffects({ platform: 'kofi', eventType: 'donation', username: 'donor-name', takeHomeUSD: 25 }));
  assert.equal(sent.length, 1,
    'real money failed to reach the ledger and nobody was paged — lesser anomalies already notify');
  assert.equal(sent[0].priority, '5', 'money-path failure must survive Do Not Disturb');
  assert.equal(sent[0].url, 'https://ntfy.example/wake');
  const text = `${sent[0].title} ${sent[0].message}`;
  assert.ok(!text.includes('donor-name'), 'a username reached a lock-screen notification');
});

// /chat/event has no direct recordSupport call to fail: the only
// ledger-write-failure path is real money's, through alert.js's logSupport
// (the test above).

// ── a DB error on the boost UPDATE is not a refusal ─────────────────────────

const BOOST = { kind: 'sticker_boost', username: 'U', coins: 200, boostCoins: 400,
  emoteName: 'pog', emoteUrl: 'https://cdn.example/pog.png',
  originalMessageId: '123', spendId: 'spend-boost-db-1' };

test('a boost whose UPDATE dies answers 503 unconfirmed — 404 would look like a refusal that already happened', async () => {
  const h = harness({
    poolQuery: async (sql) => {
      if (/SELECT 1 FROM site\.chat_messages/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/UPDATE site\.chat_messages/.test(sql)) throw new Error('db down');
      return { rows: [{}], rowCount: 1 };
    },
  });
  const res = await h.post(BOOST);
  assert.ok(h.calls.find((c) => c.fn === 'broadcast' && c.type === 'showSticker'),
    'precondition: the effects block already fired the overlay pop before the UPDATE');
  assert.notEqual(res.body?.error, 'not_a_sticker',
    'a DB error answered as a settled refusal → the web refunds coins for a boost that already showed');
  assert.equal(res.statusCode, 503, 'unclassifiable-5xx is what the web maps to unconfirmed (no refund)');
  // The key must stay in flight: the overlay effect already fired, the card
  // move did not — replaying an outcome would invent one the effects never
  // confirmed.
  const retry = await h.post(BOOST);
  assert.equal(retry.statusCode, 409);
  assert.equal(retry.body.error, 'in_flight');
});

test('a genuinely missing boost target still answers a SETTLED 404', async () => {
  // The honest-refusal path must survive the fix: rowCount 0 (not an error)
  // means the credit ALSO landed (precheck passed, row vanished mid-flight is
  // impossible — a row cannot stop being a sticker) — the recorded 404 stands.
  const h = harness({
    poolQuery: async (sql) => {
      if (/SELECT 1 FROM site\.chat_messages/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/UPDATE site\.chat_messages/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [{}], rowCount: 1 };
    },
  });
  const res = await h.post(BOOST);
  assert.equal(res.statusCode, 404);
  const retry = await h.post(BOOST);
  assert.equal(retry.statusCode, 404, 'the recorded refusal must replay');
});

// ── a throw before any credit must release the key ──────────────────────────

test('a buildEventCard throw does not wedge the spendId for its 1h TTL', async () => {
  let boom = true;
  const h = harness({
    cardBuilder: (kind, body, base, maskFn) => {
      if (boom) throw new Error('card builder bug');
      return buildEventCard(kind, body, base, maskFn);
    },
  });
  await assert.rejects(() => h.post({ ...QUIET_CHEER, spendId: 'spend-wedge-1' }),
    /card builder bug/, 'the throw must still surface to the error handler');
  boom = false;
  const retry = await h.post({ ...QUIET_CHEER, spendId: 'spend-wedge-1' });
  assert.equal(retry.statusCode, 200,
    'the retry was answered 409 in_flight — nothing had run, the key should have been released');
  assert.equal(retry.body.ok, true);
  // A cheer's effect handler is a synchronous no-op sink, so `persist` — reached
  // only after the effects block, never on a 409 in_flight response — is the
  // observable proof the retry actually ran the pipeline instead of replaying.
  assert.ok(h.calls.find((c) => c.fn === 'persist'), 'the retry must actually process — a wedged key would have 409ed before the card was ever persisted');
});


// ── platform-scoped name identity for id-less money sources ─
//
// Identity is never adopted by name match (right for chat ingest), and
// Streamlabs / Ko-fi / YouTube superchats carry no user id — so without this
// every such donation would mint a fresh canonical. recordSupport resolves
// id-less events with a platform-scoped synthetic id, `name:<lower>`: one identity per (platform,
// name), never across platforms, never for Anonymous.
const { supportPlatformId } = require('./money');

test('supportPlatformId: a real platform id is used verbatim; an id-less event resolves as name:<lower>', () => {
  assert.equal(supportPlatformId({ userId: '12345', username: 'GadgetFan' }), '12345');
  assert.equal(supportPlatformId({ userId: '', username: 'GadgetFan' }), 'name:gadgetfan');
  assert.equal(supportPlatformId({ username: '  GadgetFan ' }), 'name:gadgetfan', 'trimmed and lower-cased — the same donor with different casing is one identity');
});

test('supportPlatformId: Anonymous never gets a synthetic id (each anonymous gift stays its own row)', () => {
  assert.equal(supportPlatformId({ userId: '', username: 'Anonymous' }), '');
  assert.equal(supportPlatformId({ userId: '', username: ' anonymous ' }), '');
  assert.equal(supportPlatformId({ userId: '', username: '' }), '');
  assert.equal(supportPlatformId({ userId: '', username: null }), '');
});

test('recordSupport hands resolveOrCreate the SCOPED name id for a Streamlabs donation — one canonical per (platform, name)', async () => {
  const seen = [];
  const recordSupport = makeRecordSupport({
    pool: { query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }) },
    resolveOrCreate: async (platform, platformId, username) => { seen.push({ platform, platformId, username }); return 'canon'; },
    liveState: async () => ({ streamId: 's1' }),
  });
  await recordSupport({ platform: 'streamlabs', username: 'GadgetFan', amountUsd: 5, eventType: 'donation' });
  await recordSupport({ platform: 'kofi', username: 'gadgetfan', amountUsd: 5, eventType: 'donation' });
  assert.deepEqual(seen[0], { platform: 'streamlabs', platformId: 'name:gadgetfan', username: 'GadgetFan' });
  assert.deepEqual(seen[1], { platform: 'kofi', platformId: 'name:gadgetfan', username: 'gadgetfan' },
    'the SAME synthetic id on a different platform is a different links row — no cross-platform adoption');
  const before = seen.length;
  await recordSupport({ platform: 'twitch', userId: 'u42', username: 'GadgetFan', amountUsd: 5, eventType: 'bits' });
  assert.equal(seen[before].platformId, 'u42', 'a platform that supplies ids is untouched');
});
