// IDENTITY-UPSERT GUARD for resolveOrCreate (identity.js).
//
// What this pins: resolveOrCreate never adopts a canonical by name match
// (handles collide across platforms), so a same-handle stranger gets their own
// canonical and reaches the create path with a name_lower that ALREADY EXISTS.
// stream.nameidx.name_lower is the PRIMARY KEY, so a bare INSERT throws there.
// resolveOrCreate sits UPSTREAM of the ledger write, so that throw silently
// drops the donation's credit — while the chat alert still fires, because
// alerts are best-effort and independent of the ledger — and drops chat and
// stat writes on the ingest path for the same users.
//
// How this tests it: the real failure is a race against a live PK, which a mock
// pool cannot reproduce — what IS checkable is the WIRING: that every insert on
// the create path tolerates losing the race. identity.js is a factory, so the
// statements are CAPTURED from the real function as it executes.
// If resolveOrCreate stops issuing an insert, or drops its ON CONFLICT, the
// captured-SQL assertions fail — nothing here can pass vacuously.
//
// Losing the race is the correct outcome: nameidx confers no identity (only the read-only /profile lookup reads it), so
// first-registrant-keeps-the-entry is precisely the intended semantics.
//
// Run: node --test identity-upsert.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentity } = require('./identity');

// A pool that records every statement and answers from substring-matched
// handlers (first match wins); everything else gets empty rows.
function capturePool(handlers = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push(String(sql));
      for (const [pat, resp] of handlers) {
        if (String(sql).includes(pat)) return typeof resp === 'function' ? resp(params) : resp;
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => { throw new Error('mergeCanonicals should not run in these scenarios'); },
  };
}

function freshIdentity(pool) {
  return createIdentity({ pool, requestAggregateRefresh: () => {} });
}

// Both create-path branches must be exercised: the fresh-canonical branch and
// the linked-account branch. Guarding only one lets its unguarded twin regress
// unnoticed.
async function runFreshCreate() {
  const pool = capturePool();
  const id = await freshIdentity(pool).resolveOrCreate('kick', 'kick-123', 'SomeHandle');
  return { pool, id };
}
async function runLinkedAdopt() {
  const pool = capturePool([
    ['FROM site.accounts', { rows: [{ matrix_id: '@person:site.test' }] }],
    ['site.platform_links WHERE matrix_id', { rows: [{ id: 'abc123def456' }] }],
  ]);
  const id = await freshIdentity(pool).resolveOrCreate('kick', 'kick-456', 'LinkedHandle');
  return { pool, id };
}

for (const table of ['stream.nameidx', 'stream.links']) {
  test(`every INSERT into ${table} tolerates a conflict — on BOTH create-path branches`, async () => {
    const fresh = await runFreshCreate();
    const linked = await runLinkedAdopt();
    const inserts = [...fresh.pool.queries, ...linked.pool.queries]
      .filter((q) => q.includes(`INSERT INTO ${table}`));

    assert.ok(inserts.length >= 2,
      `expected both branches to insert into ${table}, saw ${inserts.length} — ` +
      'if a call site was removed, update this guard deliberately');
    for (const stmt of inserts) {
      assert.match(stmt, /ON CONFLICT/,
        `a bare INSERT into ${table} is back:\n  ${stmt}\n` +
        'It throws on collision, and resolveOrCreate is upstream of the money ' +
        'ledger AND the chat ingest path — so it fails both silently.');
    }
  });
}

test('no username-match adoption — nameidx is never read to resolve', async () => {
  // Behavioral form of the nameidx guard: even with a same-handle stranger, the
  // resolve path must never CONSULT nameidx — identity requires proof (a
  // stream.links row or an OAuth-linked account). If adoption returns, this
  // captures the SELECT and fails.
  const { pool, id } = await runFreshCreate();
  const nameidxReads = pool.queries.filter((q) => q.includes('SELECT canonical FROM stream.nameidx'));
  assert.deepEqual(nameidxReads, [],
    'nameidx is conferring identity again — a same-handle stranger can inherit ' +
    "another person's canonical");
  assert.match(id, /^[0-9a-f]{12}$/, 'a fresh canonical was not minted');

  // The proof-based paths must still be there, so this cannot be satisfied by
  // gutting resolution entirely.
  assert.ok(pool.queries.some((q) => q.includes('FROM stream.links WHERE platform = $1 AND platform_id = $2')),
    'the stream.links lookup (proof) is gone');
  assert.ok(pool.queries.some((q) => q.includes('FROM site.accounts')),
    'the OAuth-linked-account lookup (proof) is gone');
});

test('the linked-account branch adopts the linked canonical instead of minting an orphan', async () => {
  const { id } = await runLinkedAdopt();
  assert.equal(id, 'abc123def456',
    'an OAuth-linked platform account minted a fresh orphan instead of adopting the linked canonical');
});

test('the identity cache makes the second message a zero-query hit', async () => {
  const pool = capturePool();
  const identity = freshIdentity(pool);
  const first = await identity.resolveOrCreate('kick', 'kick-123', 'SomeHandle');
  const before = pool.queries.length;
  const second = await identity.resolveOrCreate('kick', 'kick-123', 'SomeHandle');
  assert.equal(second, first);
  assert.equal(pool.queries.length, before,
    'a cached identity with an unchanged name should not touch the DB');
});

// A coin spend (cheer/sticker/sticker_boost) credits neither the ledger nor the
// bar, so there is no ledger-before-bar ordering to guard on that path. See
// money.js's header for the accounting model.
