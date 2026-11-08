// ONE standing rule for "is this person banned?" (config/canonical-standing.mjs). Four rounds
// patched two readers that each had their own mod_log query, and they drifted. So every reader
// takes the rule from its package's GENERATED copy of the one fragment, and none keeps a query of
// its own over ban / timeout / unban rows. (That the rule is RIGHT is ban-standing.db.test.js.)
// Run: node --test canonical-standing.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { scanSource, at } = require('./testlib/source.js');
const { CANONICAL_STANDING } = require('./canonicalStanding.generated');

test('both packages carry the same fragment, generated from config/canonical-standing.mjs', async () => {
  const { CANONICAL_STANDING: fromConfig } = await import('../config/canonical-standing.mjs');
  const { CANONICAL_STANDING: inWeb } = await import('../web/app/lib/canonicalStanding.generated.mjs');
  assert.equal(CANONICAL_STANDING, fromConfig, 'stream-api\'s copy is not the config\'s fragment');
  assert.equal(inWeb, fromConfig, 'web\'s copy is not the config\'s fragment');
  // The rule's own terms: insertion order (id), the canonical's own rows, an ended timeout is nothing.
  assert.match(fromConfig, /lift\.action = 'unban' AND lift\.id > st\.id/);
  assert.match(fromConfig, /lift\.target_id = st\.target_id/);
  assert.match(fromConfig, /st\.action = 'timeout' AND st\.expires_at > now\(\)/);
  assert.doesNotMatch(fromConfig, /created_at\s+(>|<|DESC|ASC)/, 'the rule orders or compares by created_at');
});

// Each reader: [file, tail anchor, the import line, the region that judges standing].
const READERS = [
  ['ban-hold.js', /module\.exports = \{ createBanHold, PLATFORM_HOLD_MS \};\s*$/,
    "const { CANONICAL_STANDING } = require('./canonicalStanding.generated');",
    ['const CANONICAL_BANS_SQL', 'const CANONICALS_OF_SQL']],
  ['identity.js', /module\.exports = \{ createIdentity \};\s*$/,
    "const { CANONICAL_STANDING } = require('./canonicalStanding.generated');",
    ["UPDATE site.automod_held SET status = 'denied'", 'const imps = await client.query(']],
  ['../web/app/lib/platformRetry.ts', /return `Superseded by a later \$\{s\}`;\s*\}\s*$/,
    'import { CANONICAL_STANDING } from "./canonicalStanding.generated.mjs";',
    ['export async function bannedNow(', 'export function supersededLabel(']],
  // LIFT_TIMEOUT_SQL composes from accountBans.ts liftOursSql (which reads the fragment, below).
  ['../web/app/lib/community/unbans.ts', /AS banned`;\s*$/,
    'import { liftOursSql, placedBySql } from "./accountBans.ts";',
    ['export const LIFT_TIMEOUT_SQL', 'AS banned`;']],
  ['../web/app/lib/community/accountBans.ts', /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7\)`;\s*$/,
    'import { CANONICAL_STANDING } from "../canonicalStanding.generated.mjs";',
    ['export function liftOursSql(', 'export const CANONICAL_ACTION_SQL']],
];

for (const [file, anchor, importLine, [from, to]] of READERS) {
  test(`${file} judges standing only through the shared fragment`, () => {
    const src = scanSource(file, anchor);
    assert.ok(src.includes(importLine), `${file} does not take the rule from its generated copy`);
    const region = src.slice(at(src, from), at(src, to));
    assert.match(region, /\$\{CANONICAL_STANDING\}|\$\{liftOursSql\(/, `${file}: the standing region does not use the fragment`);
    // Its own query over the actions (an IN-list with 'unban', an unban-by-id join, a created_at
    // order) would be a second rule.
    assert.doesNotMatch(region, /'unban'\s*\)|action\s*=\s*'unban'\s+AND|\.id\s*>\s*\w+\.id|ORDER BY[^`]*created_at/, `${file} keeps its own standing query`);
  });
}

test('vacuity anchor: the fragment\'s source file ends with the export the copies are made from', () => {
  const src = readFileSync(join(__dirname, '..', 'config', 'canonical-standing.mjs'), 'utf8');
  assert.match(src.trimEnd(), /lift\.target_id = st\.target_id AND lift\.action = 'unban' AND lift\.id > st\.id\)`;$/);
});
