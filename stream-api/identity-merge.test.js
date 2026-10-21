// Guard for mergeCanonicals() FK coverage — identity.js.
// Run: node --test identity-merge.test.js
//
// Why this test exists: mergeCanonicals ends with
// `DELETE FROM stream.users WHERE id = ANY(victims)`. Every table holding an FK to
// stream.users must first be repointed to the survivor or deleted, or Postgres raises
// an FK violation and the ENTIRE merge transaction rolls back.
//
// Missing one (stream.support_events is NOT NULL REFERENCES stream.users(id)) fails
// the merge for every user who has ever paid — silently, since the caller sees a
// thrown error rather than a wrong result.
//
// The FK-COMPLETENESS check stays a source scan on purpose, even now that
// identity.js is importable: it cross-references every `REFERENCES
// stream.users` declaration across migrations/ against the function body —
// a completeness property over the SCHEMA that no stubbed-pool run can prove.
// Adding a new user-keyed table without handling it here fails this test
// instead of production. The ORDERING invariant, by contrast, is now also
// pinned behaviorally below by capturing the real statement sequence.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createIdentity } = require('./identity');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS = path.join(REPO, 'migrations');

/** Every `stream.<table>` that declares an FK to stream.users and still EXISTS.
 *  Replays CREATE and DROP in migration order — reading only CREATEs would keep
 *  a table dropped by a later migration in the set forever. Numeric order
 *  matters: readdir's lexical order runs v100 before v11, which would apply a
 *  drop before the create it undoes. */
function tablesWithFkToStreamUsers() {
  const ordered = fs.readdirSync(MIGRATIONS)
    .filter((f) => /^migrate-v\d+\.sql$/.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  // The schema a database is built from: the whole migration chain where this repo has it, else
  // (the public repo) the fresh-install baseline — the same schema, by the baseline gate — and the
  // migrations after it.
  const start = fs.existsSync(path.join(MIGRATIONS, 'schema.sql')) ? 'schema.sql' : path.join('baseline', 'schema.sql');
  const found = new Set();
  for (const file of [start, ...ordered]) {
    const lines = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8').split('\n');
    let current = null;
    for (const line of lines) {
      // An FK is declared inside CREATE TABLE, or added by ALTER TABLE (how pg_dump writes every one).
      const created = line.match(/(?:CREATE TABLE (?:IF NOT EXISTS )?|ALTER TABLE (?:ONLY )?)(stream\.\w+)/i);
      if (created) current = created[1];
      if (current && /REFERENCES\s+stream\.users\s*\(/i.test(line)) found.add(current);
      const dropped = line.match(/DROP TABLE (?:IF EXISTS )?(stream\.\w+)/i);
      if (dropped) found.delete(dropped[1]);
      // A rename (e.g. the bot tables' old prefix → stream.bot_*) moves the FK with the table.
      const renamed = line.match(/ALTER TABLE (?:IF EXISTS )?(stream\.\w+)\s+RENAME TO (\w+)/i);
      if (renamed && found.delete(renamed[1])) found.add(`stream.${renamed[2]}`);
    }
  }
  return found;
}

/** Source text of the mergeCanonicals function body. */
function mergeCanonicalsBody() {
  const src = fs.readFileSync(path.join(__dirname, 'identity.js'), 'utf8');
  const start = src.indexOf('async function mergeCanonicals(');
  assert.notEqual(start, -1, 'mergeCanonicals not found in identity.js — did it get renamed?');
  const next = src.indexOf('\n  async function ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

test('every table with an FK to stream.users is handled in mergeCanonicals', () => {
  const tables = tablesWithFkToStreamUsers();
  const body = mergeCanonicalsBody();

  // Floor = the live FK tables at the time of writing — the anchor that catches
  // a parser gone vacuous, not a completeness claim.
  assert.ok(tables.size >= 6, `expected >=6 FK tables, parsed ${tables.size} — parser may be stale`);

  const unhandled = [...tables].filter((t) => !body.includes(t));
  assert.deepEqual(
    unhandled,
    [],
    `mergeCanonicals never mentions ${unhandled.join(', ')}. Each must be repointed to the ` +
      `survivor or deleted before DELETE FROM stream.users, or the merge rolls back on an FK ` +
      `violation. See migrate-v5.sql for the canonical repoint set.`
  );
});

test('support_events is repointed, not deleted (payment history must survive a merge)', () => {
  const body = mergeCanonicalsBody();
  assert.match(
    body,
    /UPDATE stream\.support_events SET user_id = \$1 WHERE user_id = \$2/,
    'support_events must be REPOINTED to the survivor — deleting it would destroy the ' +
      'payment history that the support bar and lifetime totals are computed from.'
  );
  assert.doesNotMatch(
    body,
    /DELETE FROM stream\.support_events/,
    'support_events must never be deleted during a merge.'
  );
});

test('a real merge repoints support_events BEFORE deleting users, and refreshes ONCE, coalesced', async () => {
  // Behavioral twin of the scans: run the actual function against a capture
  // pool and assert on the statement sequence it issues — plus the M32 wiring
  // (merge must go through requestAggregateRefresh, never detach its own
  // rebuild; this replaced aggregate-refresh.test.js's source scan).
  const statements = [];
  const client = {
    query: async (sql) => { statements.push(String(sql)); return { rows: [], rowCount: 0 }; },
    release: () => {},
  };
  let refreshes = 0;
  const pool = {
    query: async (sql) => {
      statements.push(String(sql));
      if (String(sql).includes('COALESCE(us.activity, 0)')) {
        return { rows: [
          { id: 'aaa111aaa111', activity: 10, first_seen: '2024-01-01' },
          { id: 'bbb222bbb222', activity: 2,  first_seen: '2024-06-01' },
        ] };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client,
  };
  const identity = createIdentity({ pool, requestAggregateRefresh: () => { refreshes++; } });

  const r = await identity.mergeCanonicals(['aaa111aaa111', 'bbb222bbb222']);
  assert.equal(r.survivor, 'aaa111aaa111', 'survivor must be the most-active canonical');
  assert.equal(r.merged, 1);

  const idx = (pat) => statements.findIndex((s) => s.includes(pat));
  assert.ok(idx('UPDATE stream.support_events SET user_id = $1 WHERE user_id = $2') !== -1,
    'the support_events repoint never ran');
  assert.ok(idx('DELETE FROM stream.users') !== -1, 'the closing users delete never ran');
  assert.ok(
    idx('UPDATE stream.support_events SET user_id = $1 WHERE user_id = $2') < idx('DELETE FROM stream.users'),
    'support_events repointed AFTER the users delete — the merge would roll back on the FK'
  );
  assert.equal(statements.filter((s) => s === 'COMMIT').length, 1, 'merge did not commit');
  assert.equal(refreshes, 1,
    'merge must request exactly one coalesced aggregate refresh — ' +
    'zero means stats go stale, more means it detached its own rebuilds again');
});

test('the closing DELETE FROM stream.users is still the last FK-relevant statement', () => {
  // If this ordering ever inverts, repoints would run after the delete and the guard above
  // would pass while production still broke.
  // Match the executed query, not prose — the loop carries a comment naming this statement.
  const body = mergeCanonicalsBody();
  const del = body.search(/client\.query\(\s*'DELETE FROM stream\.users/);
  const repoint = body.search(/client\.query\(\s*'UPDATE stream\.support_events/);
  assert.notEqual(del, -1, 'expected a DELETE FROM stream.users query in mergeCanonicals');
  assert.notEqual(repoint, -1, 'expected a support_events repoint query in mergeCanonicals');
  assert.ok(repoint < del, 'support_events must be repointed BEFORE stream.users rows are deleted');
});
