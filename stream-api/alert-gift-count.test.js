// Ticket #168: a YouTube gift of ten memberships (2026-10-07 02:21 PT) was ONE
// `membership-gift` row at $3.49 — one membership's take-home. The count was lost in
// stream-ingest: its parser read /gifted\s+(\d+)/ while YouTube's banner says "Sent 10
// <channel> gift memberships", and fell back to 1 in silence. stream-ingest's
// ytGiftCount.test.js pins the parse. This file pins the OTHER half: once the count
// reaches /alert, the ledger amount, the bar and the chat card all carry it — on the
// first delivery, on a retry of the same event, and after a restart.
//
// Run: node --test alert-gift-count.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlert } = require('./alert');
const economics = require('./economics');

// What stream-ingest's normalizeYouTubeEvent sends for the 10-07 banner.
const TEN_GIFTS = {
  platform: 'youtube', eventType: 'membership-gift', username: 'casey', userImage: '',
  eventId: 'youtube:gift-10-07', count: 10, label: 'gifted 10 memberships',
};
const ONE = economics.takeHome('youtube', 'membership-gift', { count: 1 });
const TEN = economics.takeHome('youtube', 'membership-gift', { count: 10 });

/** A ledger that outlives any one alert instance — the database across a restart. */
function durableLedger() {
  const rows = new Map();
  return {
    rows,
    logSupport: async ({ eventId, amountUsd }) => {
      if (rows.has(eventId)) return { duplicate: true };
      rows.set(eventId, amountUsd);
      return { duplicate: false, ledgerId: rows.size };
    },
  };
}

function rig(ledger) {
  const bar = [];
  const cards = [];
  const alert = createAlert({
    broadcast: (f) => { if (f.type === 'message') cards.push(f); },
    bufferPush: () => {},
    supportBar: { add: (usd) => { bar.push(usd); return { deltaSeconds: 0 }; } },
    obs: null, tts: null, lights: null,
    logSupport: ledger.logSupport,
    logUnpriced: async () => ({ duplicate: false }),
    persistCard: async () => null,
  });
  return { alert, bar, cards };
}

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { Object.assign(console, saved); }
};

test('#168 original path: a ten-gift credits ten memberships to the ledger, the bar and the card', async () => {
  assert.ok(ONE > 0 && TEN > 9 * ONE, 'precondition: ten gifted memberships are worth ten of one');
  const ledger = durableLedger();
  const { alert, bar, cards } = rig(ledger);
  await quietly(() => alert.dispatch(TEN_GIFTS));
  assert.equal(ledger.rows.get('alert:youtube:youtube:gift-10-07'), TEN, `the ledger row is not ten memberships (one = ${ONE})`);
  assert.deepEqual(bar, [TEN], 'the bar did not move by ten memberships');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].label, 'gifted 10 memberships');
});

test('#168 retry: the same ten-gift delivered again credits nothing more', async () => {
  const ledger = durableLedger();
  const { alert, bar, cards } = rig(ledger);
  await quietly(() => alert.dispatch(TEN_GIFTS));
  const second = await quietly(() => alert.dispatch(TEN_GIFTS));
  assert.equal(second.deduped, true);
  assert.equal(ledger.rows.size, 1);
  assert.deepEqual(bar, [TEN], 'a retry moved the bar a second time');
  assert.equal(cards.length, 1, 'a retry posted a second card');
});

test('#168 restart: a fresh process receiving the same ten-gift credits nothing more', async () => {
  const ledger = durableLedger();
  await quietly(() => rig(ledger).alert.dispatch(TEN_GIFTS));
  const after = rig(ledger); // a new process: in-memory guards are gone, the ledger is not
  const r = await quietly(() => after.alert.dispatch(TEN_GIFTS));
  assert.equal(r.deduped, true);
  assert.equal(ledger.rows.get('alert:youtube:youtube:gift-10-07'), TEN, 'the row changed on the redelivery');
  assert.deepEqual(after.bar, [], 'the restarted process credited the bar again');
  assert.equal(after.cards.length, 0);
});
