// resolveOrCreate never renames a person (names.js owns stream.users.name).
// A donation's name is TYPED (a donor can tip under any name), so writing the
// name it is handed would rename the person. Every path that finds an EXISTING person is
// checked here: the cache hit, the stream.links hit, and the OAuth-linked
// account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentity } = require('./identity');
const { NATIVE_PLATFORM } = require('./native-platform');

const RENAME = /UPDATE stream\.users SET name/;

function pool({ linked = false, link = false } = {}) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push({ sql, params });
      if (/FROM stream\.links WHERE platform = \$1 AND platform_id = \$2/.test(sql)) {
        return { rows: link ? [{ canonical: 'abcabcabcabc' }] : [] };
      }
      if (/FROM site\.accounts/.test(sql)) return { rows: linked ? [{ matrix_id: '@b:site.test' }] : [] };
      if (/site\.platform_links|stream\.links/.test(sql) && linked) return { rows: [{ id: 'abcabcabcabc', canonical: 'abcabcabcabc' }] };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('a known account (stream.links) is not renamed by the name it arrives with — e.g. a typed donation name', async () => {
  const p = pool({ link: true });
  const { resolveOrCreate } = createIdentity({ pool: p, requestAggregateRefresh: () => {} });
  assert.equal(await resolveOrCreate(NATIVE_PLATFORM, '@bram:site.test', 'Vadimir Putin'), 'abcabcabcabc');
  assert.ok(!p.seen.some((q) => RENAME.test(q.sql)), 'renamed on a stream.links hit');
});

test('the cached hot path does not rename either', async () => {
  const p = pool({ link: true });
  const { resolveOrCreate } = createIdentity({ pool: p, requestAggregateRefresh: () => {} });
  await resolveOrCreate('twitch', '10000001', 'Bram');
  await resolveOrCreate('twitch', '10000001', 'cleo');   // same account, different name → cache hit
  assert.ok(!p.seen.some((q) => RENAME.test(q.sql)), 'renamed on a cache hit');
});

test('an OAuth-linked account adopted for the first time is not renamed', async () => {
  const p = pool({ linked: true });
  const { resolveOrCreate } = createIdentity({ pool: p, requestAggregateRefresh: () => {} });
  await resolveOrCreate('twitch', '999', 'SomeTypedName');
  assert.ok(!p.seen.some((q) => RENAME.test(q.sql)), 'renamed on the linked-account path');
});

test('a brand-new person is still created under the name they arrive with', async () => {
  const p = pool();
  const { resolveOrCreate } = createIdentity({ pool: p, requestAggregateRefresh: () => {} });
  const id = await resolveOrCreate('kofi', 'name:newdonor', 'NewDonor');
  const created = p.seen.find((q) => /INSERT INTO stream\.users/.test(q.sql));
  assert.deepEqual(created.params.slice(0, 2), [id, 'NewDonor']);
});

test('the name rule runs with the aggregate rebuild', () => {
  const src = require('node:fs').readFileSync(require.resolve('./aggregates'), 'utf8');
  assert.match(src, /refreshNames\(pool\)/, 'aggregates.js must apply the naming rule');
  // Vacuity anchor: the scan reached the end of the file.
  assert.match(src, /module\.exports = \{ createAggregates, makeRefresher, REFRESH_MS \};\s*$/);
});
