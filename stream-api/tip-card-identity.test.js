// A tip card wears the tipper's account (badges, picture, colour, style, the user-card click)
// only when the name on it IS the account's own. A tip given under a typed name that differs
// is a PLAIN card: the web billing paths send it as { donorMatrixId: null, payerMatrixId,
// tipIdentity: 'plain' } and this file pins what stream-api does with that shape:
//   • /chat/event accepts it (no donorMatrixId with anonymous=false is a real tip, not junk);
//   • the public card — the WS frame, the replay buffer and the persisted event_json — carries
//     no account id, no colour and no style;
//   • the money record still knows who paid: the ledger's userId and the row's matrix_id
//     (refunds, statements, a moderator's reach) are the payer.
//
// Run: node --test tip-card-identity.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMoney, makePersistEventCard } = require('./money.js');
const { buildEventCard } = require('./alert.js');
const { publicReplacer } = require('./ws-hub.js');

const PAYER = '@casey:site.test';
const BASE = { type: 'message', platform: 'system', id: 'd1', system: 'donation', ts: 1 };

const PLAIN = {
  kind: 'donation', donor: 'Your Mom', donorMatrixId: null, payerMatrixId: PAYER, tipIdentity: 'plain',
  anonymous: false, amount: 500, currency: 'usd', message: 'hi', spendId: 'donation:cs_plain1',
  usernameColor: null, usernameStyle: null,
};
const ACCOUNT = {
  kind: 'donation', donor: 'Casey', donorMatrixId: PAYER, anonymous: false, amount: 500, currency: 'usd',
  message: 'hi', spendId: 'donation:cs_acct1', usernameColor: '#ff8800', usernameStyle: { font: 'pixel' },
};

/** Every key on a frame or card that would tie it to an account. */
const IDENTITY_KEYS = ['matrixId', 'donorMatrixId', 'payerMatrixId', 'canonicalId', 'publicId', 'usernameColor', 'usernameStyle', 'avatarUrl'];
function assertPlain(obj, where) {
  for (const k of IDENTITY_KEYS) {
    assert.ok(obj[k] == null, `${where} carries ${k}=${JSON.stringify(obj[k])} on a plain tip`);
  }
  assert.ok(!JSON.stringify(obj).includes(PAYER), `${where} carries the payer's account id somewhere`);
}

function harness({ ledgerDuplicate = false } = {}) {
  const frames = [];
  const buffered = [];
  const persisted = [];
  const effects = [];
  const money = createMoney({
    pool: { query: async () => ({ rows: [{}], rowCount: 1 }) },
    economics: { stripeNet: (usd) => usd * 0.83, formatUSD: (u) => `$${u.toFixed(2)}` },
    alert: {
      buildEventCard,
      fireStreamEffects: async (args) => { effects.push(args); return { addedSeconds: 0, duplicate: ledgerDuplicate }; },
      dispatch: async () => {},
    },
    supportBar: { add: () => ({ deltaSeconds: 0 }), reset: () => {} },
    timer: { reset() {}, adjust() { return 0; }, set() { return 0; }, control() { return true; }, setConfig() { return { usdPerHour: 0, fillUsd: 0 }; } },
    tts: { speak: () => {} },
    sounds: { play: async () => true, manifest: () => ({}) },
    cleanForTTS: (t) => t,
    persistEventCard: async (card, actor) => { persisted.push({ card: JSON.parse(JSON.stringify(card)), actor }); return 77; },
    maskBlacklist: (t) => t,
    broadcast: (f) => frames.push(JSON.parse(JSON.stringify(f))),
    bufferPush: (m) => buffered.push(JSON.parse(JSON.stringify(m))),
    bufferReplace: () => {},
    ttsEnabled: () => false,
  });
  const routes = {};
  money.registerMoneyRoutes(
    { post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: (p, ...h) => { routes[p] = h[h.length - 1]; } },
    { requireInternal: (req, res, next) => next(), wrap: (fn) => fn },
  );
  const post = async (body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/chat/event']({ body }, res);
    return res;
  };
  return { post, frames, buffered, persisted, effects };
}

test('buildEventCard: a plain tip card carries the typed name and no account, colour or style — even if they were sent', () => {
  const card = buildEventCard('donation', { ...PLAIN, usernameColor: '#ff8800', usernameStyle: { font: 'pixel' } }, BASE, (s) => s);
  assert.equal(card.username, 'Your Mom');
  assert.equal(card.anonymous, false);
  assert.equal(card.tipIdentity, 'plain');
  assertPlain(card, 'the built card');
});

test('buildEventCard: a tip under the account\'s own name wears the account', () => {
  const card = buildEventCard('donation', ACCOUNT, BASE, (s) => s);
  assert.equal(card.tipIdentity, 'account');
  assert.equal(card.matrixId, PAYER);
  assert.equal(card.donorMatrixId, PAYER);
  assert.equal(card.usernameColor, '#ff8800');
  assert.deepEqual(card.usernameStyle, { font: 'pixel' });
  assert.equal(card.payerMatrixId, undefined, 'the payer key is never on a card');
});

test('buildEventCard: an anonymous tip stays Anonymous and plain, whatever ids it was sent', () => {
  const card = buildEventCard('donation', { ...ACCOUNT, anonymous: true, payerMatrixId: PAYER }, BASE, (s) => s);
  assert.equal(card.username, 'Anonymous');
  assert.equal(card.tipIdentity, 'plain');
  assertPlain(card, 'the anonymous card');
});

test('original path: /chat/event accepts the plain shape — public card plain, money record keeps the payer', async () => {
  const h = harness();
  const res = await h.post(PLAIN);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true, `the plain shape was refused: ${JSON.stringify(res.body)}`);
  // The ledger knows who paid (support_events, refunds): the payer, not a fresh identity.
  assert.equal(h.effects.length, 1);
  assert.equal(h.effects[0].userId, PAYER, 'the ledger lost the payer of a plain tip');
  assert.equal(h.effects[0].username, 'Your Mom');
  // The row's matrix_id is the payer (a moderator's reach, account erase); event_json is not.
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].actor, PAYER, 'the persisted row lost the payer');
  assertPlain(h.persisted[0].card, 'the persisted event_json');
  // The live frame and the replay buffer — what every viewer's socket gets.
  assert.equal(h.frames.length, 1);
  assertPlain(h.frames[0], 'the live WS frame');
  assertPlain(JSON.parse(JSON.stringify(h.frames[0], publicReplacer)), 'the public WS frame');
  assert.equal(h.buffered.length, 1);
  assertPlain(h.buffered[0], 'the replay buffer');
  assert.equal(h.frames[0].username, 'Your Mom');
  assert.equal(h.frames[0].tipIdentity, 'plain');
});

test('an account tip is unchanged: the card wears the account and the ledger keys on it', async () => {
  const h = harness();
  await h.post(ACCOUNT);
  assert.equal(h.effects[0].userId, PAYER);
  assert.equal(h.persisted[0].actor, PAYER);
  assert.equal(h.frames[0].matrixId, PAYER);
  assert.equal(h.frames[0].usernameColor, '#ff8800');
});

test('a payerMatrixId on a tip that is not plain is ignored — only donorMatrixId speaks for an account card', async () => {
  const h = harness();
  await h.post({ ...ACCOUNT, payerMatrixId: '@someone-else:site.test' });
  assert.equal(h.effects[0].userId, PAYER);
  assert.equal(h.persisted[0].actor, PAYER);
  const anon = harness();
  await anon.post({ ...PLAIN, anonymous: true, tipIdentity: 'plain' });
  assert.equal(anon.effects[0].userId, undefined, 'an anonymous tip must stay unattributed, as before');
  assert.equal(anon.persisted[0].actor, null);
});

test('retry: a redelivered plain tip (same spendId) posts no second card and keeps no payer on the replayed answer', async () => {
  const h = harness();
  await h.post(PLAIN);
  const again = await h.post(PLAIN);
  assert.equal(again.body.deduped, true);
  assert.equal(h.frames.length, 1, 'a retry posted a second card');
  assert.equal(h.persisted.length, 1);
  assert.ok(!JSON.stringify(again.body).includes(PAYER), 'the replayed answer carries the payer');
});

test('restart: after a restart the ledger answers duplicate — no card, and the plain shape is still accepted', async () => {
  const fresh = harness({ ledgerDuplicate: true }); // empty spendOutcomes, ledger already holds the event
  const res = await fresh.post(PLAIN);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deduped, true);
  assert.equal(fresh.effects[0].userId, PAYER, 'the replay must reach the ledger under the same payer to dedup');
  assert.equal(fresh.frames.length, 0);
  assert.equal(fresh.persisted.length, 0);
});

test('persistEventCard: the actor passed for a plain tip is the row\'s matrix_id; the card stays plain in event_json', async () => {
  const seen = [];
  const pool = { query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ id: '5' }] }; } };
  const persist = makePersistEventCard(pool);
  const card = buildEventCard('donation', PLAIN, BASE, (s) => s);
  assert.equal(await persist(card, PAYER), 5);
  assert.equal(seen[0].params[0], PAYER);
  assertPlain(JSON.parse(seen[0].params[3]), 'event_json');
  // Without an actor the card's own key decides, as for every other kind.
  seen.length = 0;
  await persist(buildEventCard('donation', ACCOUNT, BASE, (s) => s));
  assert.equal(seen[0].params[0], PAYER);
});
