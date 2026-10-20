// recordUnpriced (review round 2, R2-1): a payment the ledger cannot price
// lands in stream.unpriced_support (v151) with its native amount and raw
// string, and its unique event_id answers "already recorded" for a replay.
// Run: node --test money-unpriced.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRecordUnpriced } = require('./money.js');

test('recordUnpriced writes the native amount, the raw string and the event_id, ON CONFLICT DO NOTHING', async () => {
  const queries = [];
  let rowCount = 1;
  const rec = makeRecordUnpriced({
    pool: { query: async (sql, params) => { queries.push({ sql, params }); return { rows: rowCount ? [{ id: 1 }] : [], rowCount }; } },
    liveState: async () => ({ streamId: 'st-1' }),
  });
  const first = await rec({ platform: 'youtube', eventType: 'superchat', username: 'casey', amountNative: 5000,
    currency: 'UNKNOWN', raw: 'F CFA 5,000', message: 'hola', eventId: 'alert:youtube:youtube:r-1' });
  const q = queries[0];
  assert.match(q.sql, /INSERT INTO stream\.unpriced_support/);
  assert.doesNotMatch(q.sql, /INSERT INTO stream\.support_events/, 'an unpriced payment must never reach the ledger the totals sum');
  assert.match(q.sql, /NOT EXISTS \(SELECT 1 FROM stream\.support_events e WHERE e\.event_id = \$1::text\)/,
    'an event the ledger already holds must answer "already recorded" here too');
  assert.match(q.sql, /ON CONFLICT \(event_id\) WHERE event_id IS NOT NULL DO NOTHING/);
  for (const v of [5000, 'UNKNOWN', 'F CFA 5,000', 'alert:youtube:youtube:r-1', 'st-1', 'casey']) {
    assert.ok(q.params.includes(v), `${v} did not reach the row`);
  }
  assert.equal(first.duplicate, false);
  rowCount = 0;
  const second = await rec({ platform: 'youtube', eventType: 'superchat', username: 'casey', amountNative: 5000,
    currency: 'UNKNOWN', raw: 'F CFA 5,000', eventId: 'alert:youtube:youtube:r-1' });
  assert.equal(second.duplicate, true, 'a swallowed insert must be reported, or the replay fires every effect again');
});
