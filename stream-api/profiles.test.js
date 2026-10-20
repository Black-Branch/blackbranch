'use strict';
// /user/lookup carries the owner plugin's own fields (profileExtras) and, without a plugin,
// nothing but the product's. Run: node --test profiles.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mountLookup } = require('./testlib/profile-lookup');

test('without a plugin the profile is the product fields only', async () => {
  const body = await mountLookup(null)({ canonicalId: 'c1' });
  assert.equal(body.canonicalId, 'c1');
  assert.equal(body.name, 'ann');
  assert.deepEqual(Object.keys(body).filter((k) => /impression/i.test(k)), []);
});

test("a plugin's fields are added, and a failing one costs the profile nothing", async () => {
  const added = await mountLookup(async ({ canonicalId }) => ({ extraField: `for ${canonicalId}` }))({ canonicalId: 'c1' });
  assert.equal(added.extraField, 'for c1');
  assert.equal(added.name, 'ann');
  const failing = await mountLookup(async () => { throw new Error('boom'); })({ canonicalId: 'c1' });
  assert.equal(failing.name, 'ann');
  assert.equal(failing.extraField, undefined);
});
