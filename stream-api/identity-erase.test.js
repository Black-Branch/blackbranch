// identity.js and a deleted account (account-erase.js): the identity cache forgets the deleted
// canonicals per key, and the erased-person row can never be merged into a living person.
//
// Run: node --test identity-erase.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentity } = require('./identity');
const { ERASED_CANONICAL } = require('./account-erase');

// A pool that answers the platform-link SELECT from a table and records every statement.
function linkPool(links) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push(sql);
      if (/SELECT canonical FROM stream\.links WHERE platform = \$1 AND platform_id = \$2/.test(sql)) {
        const c = links[`${params[0]}:${params[1]}`];
        return { rows: c ? [{ canonical: c }] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('forgetCanonicals drops only the deleted canonicals\' cached platform ids', async () => {
  const links = { 'twitch:t1': 'aaaaaaaaaaaa', 'kick:k1': 'aaaaaaaaaaaa', 'twitch:t2': 'bbbbbbbbbbbb' };
  const pool = linkPool(links);
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const all = Object.keys(links).map((k) => k.split(':'));
  for (const [p, id] of all) await identity.resolveOrCreate(p, id, id);
  const before = pool.seen.length;
  // All three are cached: a second resolve reads nothing.
  for (const [p, id] of all) await identity.resolveOrCreate(p, id, id);
  assert.equal(pool.seen.length, before, 'premise: the cache did not hold the three ids');

  assert.equal(identity.forgetCanonicals(['aaaaaaaaaaaa']), 2);
  await identity.resolveOrCreate('twitch', 't2', 't2');
  assert.equal(pool.seen.length, before, 'someone else\'s cached id was dropped too');
  await identity.resolveOrCreate('twitch', 't1', 't1');
  await identity.resolveOrCreate('kick', 'k1', 'k1');
  assert.equal(pool.seen.length, before + 2, 'a deleted canonical\'s platform id was still answered from the cache');
  assert.equal(identity.forgetCanonicals([]), 0);
});

test('the erased-person row is never merged into anyone', async () => {
  const pool = { query: async (sql) => { throw new Error(`a merge involving the erased-person row reached the database: ${sql}`); } };
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const r = await identity.mergeCanonicals([ERASED_CANONICAL, 'cccccccccccc']);
  assert.deepEqual(r, { ok: true, survivor: 'cccccccccccc', merged: 0 });
});

test('index.js hands the erase the identity cache and the sponsor pool (the in-memory copies P8 is about)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /createAccountErase\(\{ pool, memory, identity, sponsors, msgBuffer, broadcast, redactBuffered \}\)/);
  // The hooks the erase calls exist under those names.
  assert.match(src, /const identity = createIdentity\(/);
  assert.match(src, /const sponsors = createSponsors\(/);
  assert.match(src.slice(-200), /process\.on\('unhandledRejection'[\s\S]*\}\);\s*$/, 'END anchor: index.js was read to its end');
});
