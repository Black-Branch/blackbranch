// Which logged messages get the best-effort enrichment (scoring / embedding) —
// and which never should.
//
// A dedup-SUPPRESSED echo answers `{ suppressed: true }` with no row id of its
// own (the text-window path knows no native id); scoring it would PATCH
// /chat/undefined/karma. Enrichment is for a row that exists; a suppressed echo
// is not one.
//
// Run: node --test lib/pipelineEnrich.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEnrich, SHED_ENRICH_AT } from './pipeline.js';

test('a suppressed echo is never enriched, with or without an id', () => {
  assert.equal(shouldEnrich({ logged: { id: 123, suppressed: true }, isBot: false, backlog: 0 }), false);
  assert.equal(shouldEnrich({ logged: { id: undefined, suppressed: true }, isBot: false, backlog: 0 }), false);
});

test('no usable row id → nothing to PATCH', () => {
  for (const id of [undefined, null, '', 'undefined', 'abc']) {
    assert.equal(shouldEnrich({ logged: { id }, isBot: false, backlog: 0 }), false, `id ${JSON.stringify(id)}`);
  }
});

test('an ordinary logged row is enriched; bots and a backed-up queue are not', () => {
  assert.equal(shouldEnrich({ logged: { id: 123 }, isBot: false, backlog: 0 }), true);
  assert.equal(shouldEnrich({ logged: { id: '123' }, isBot: false, backlog: 0 }), true, 'a numeric string id is a row');
  assert.equal(shouldEnrich({ logged: { id: 123 }, isBot: true, backlog: 0 }), false);
  assert.equal(shouldEnrich({ logged: { id: 123 }, isBot: false, backlog: SHED_ENRICH_AT + 1 }), false);
});
