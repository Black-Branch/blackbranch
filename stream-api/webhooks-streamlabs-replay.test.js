// webhooks.js: the Streamlabs replay guard (review round 2, R2-3).
// Run: node --test webhooks-streamlabs-replay.test.js
//
// Streamlabs re-emits its donation history on reconnect, and its handler had
// no in-memory replay guard (Ko-fi, Patreon and /alert each have one), so a
// reconnect re-fired the overlay, sound, lights, TTS and chat card for every
// donation in the replayed history. alert.js now asks the ledger first as the
// durable answer; this guard stops the replay before it gets that far.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamlabsHandler } = require('./webhooks.js');

// ── Streamlabs ──────────────────────────────────────────────────────────────

function streamlabsRig() {
  const dispatched = [];
  const handler = createStreamlabsHandler({ alert: { dispatch: async (x) => { dispatched.push(x); } } });
  return { dispatched, handler };
}

const donation = (id, name = 'casey') => ({ _id: id, name, amount: '5.00', currency: 'USD', message: 'hi' });

test('a Streamlabs donation re-emitted on reconnect dispatches once', () => {
  const { dispatched, handler } = streamlabsRig();
  const quiet = console.log;
  console.log = () => {};
  try {
    handler({ type: 'donation', message: [donation('d-1')] });
    handler({ type: 'donation', message: [donation('d-1'), donation('d-2')] }); // history replay after reconnect
  } finally { console.log = quiet; }
  assert.deepEqual(dispatched.map((d) => d.eventId), ['d-1', 'd-2'],
    'a replayed Streamlabs donation reached dispatch again — every effect fires twice');
});

test('a Streamlabs donation with no _id is never deduped (fail-open)', () => {
  const { dispatched, handler } = streamlabsRig();
  const quiet = console.log;
  console.log = () => {};
  try {
    handler({ type: 'donation', message: [{ name: 'casey', amount: '1', currency: 'USD' }] });
    handler({ type: 'donation', message: [{ name: 'casey', amount: '1', currency: 'USD' }] });
  } finally { console.log = quiet; }
  assert.equal(dispatched.length, 2);
});
