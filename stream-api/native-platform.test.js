// The site's own platform id (native-platform.js): one id, written and read, and the SQL list that
// names it. The identity readers ask for it, never for a platform's own id.
const test = require('node:test');
const assert = require('node:assert/strict');
const np = require('./native-platform');
const { createIdentity } = require('./identity');

test('"native" is the site\'s own platform, and the SQL list names exactly it', () => {
  assert.equal(np.NATIVE_PLATFORM, 'native');
  assert.equal(np.NATIVE_SQL, "('native')");
  assert.equal(np.isNativePlatform('native'), true);
  for (const p of ['twitch', 'youtube', 'kick', 'streamplace', '', null, undefined, 'NATIVE', 'system']) {
    assert.equal(np.isNativePlatform(p), false, String(p));
  }
});

test('a site account resolves through its native stream.links row; a new one is linked under "native"', async () => {
  const seen = [];
  const pool = { query: async (sql, params = []) => { seen.push({ sql, params }); return { rows: [], rowCount: 0 }; } };
  const id = createIdentity({ pool, requestAggregateRefresh: () => {} });
  await id.resolveCanonical(null, '@x:site.test');
  assert.match(seen[0].sql, /FROM stream\.links WHERE platform IN \('native'\) AND platform_id = \$1/);
  await id.resolveOrCreate(np.NATIVE_PLATFORM, '@new:site.test', 'New');
  const link = seen.find((q) => /INSERT INTO stream\.links/.test(q.sql));
  assert.equal(link.params[0], 'native');
});
