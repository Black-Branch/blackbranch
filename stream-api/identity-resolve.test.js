// POST /identity/resolve — a site sign-in is the proof the identity model
// needs for the site's own platform.
// Wiring test: the route exists, is internal, validates, and returns the
// canonical resolveOrCreate hands back for exactly the (platform, userId,
// username) it was given.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIdentity } = require('./identity');
const { NATIVE_PLATFORM } = require('./native-platform');

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    post: (path, ...handlers) => routes.set(`POST ${path}`, handlers),
    get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
  };
}
function fakeRes() {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
// A pool with a person reachable one of three ways: `native` = a stream.links
// (native, matrixId) row; `platform` = a site.platform_links row only
// (platform-linked, never chatted natively); `none` = nobody. Any other query answers empty.
function poolWith(kind, canonical) {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push({ sql, params });
      if (/FROM stream\.links WHERE platform IN \('native'[^)]*\) AND platform_id = \$1/.test(sql) && /site\.platform_links/.test(sql)) {
        return { rows: kind === 'none' ? [] : [{ id: canonical }] }; // resolveCanonical's UNION
      }
      if (/FROM stream\.links WHERE platform = \$1 AND platform_id = \$2/.test(sql)) {
        return { rows: kind === 'native' ? [{ canonical }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const poolWithLink = (canonical) => poolWith('native', canonical);

const requireInternal = function requireInternal() {};
const wrap = (fn) => fn;

test('POST /identity/resolve is registered behind requireInternal', () => {
  const app = fakeApp();
  const id = createIdentity({ pool: poolWithLink('abc123abc123'), requestAggregateRefresh: () => {} });
  id.registerIdentityRoutes(app, { requireInternal, wrap });
  const handlers = app.routes.get('POST /identity/resolve');
  assert.ok(handlers, 'route missing');
  assert.equal(handlers[0], requireInternal);
});

test('a person with a native link gets that canonical back — no rename, nothing created', async () => {
  const app = fakeApp();
  const pool = poolWith('native', 'abc123abc123');
  const id = createIdentity({ pool, requestAggregateRefresh: () => {} });
  id.registerIdentityRoutes(app, { requireInternal, wrap });
  const [, handler] = app.routes.get('POST /identity/resolve');
  const res = fakeRes();
  await handler({ body: { platform: NATIVE_PLATFORM, userId: '@k:site.test', username: 'Kay' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { ok: true, canonicalId: 'abc123abc123', created: false });
  assert.ok(!pool.seen.some((q) => /UPDATE stream\.users SET name/.test(q.sql)), 'a returning person is never renamed at sign-in');
  assert.ok(!pool.seen.some((q) => /INSERT INTO stream\.users/.test(q.sql)), 'nothing created');
});

test('a person known only through a linked platform gets THAT canonical — not a second, blank one', async () => {
  const app = fakeApp();
  const pool = poolWith('platform', 'twitchcanon1');
  const id = createIdentity({ pool, requestAggregateRefresh: () => {} });
  id.registerIdentityRoutes(app, { requireInternal, wrap });
  const [, handler] = app.routes.get('POST /identity/resolve');
  const res = fakeRes();
  await handler({ body: { platform: NATIVE_PLATFORM, userId: '@t:site.test', username: 'Taco' } }, res);
  assert.deepEqual(res.body, { ok: true, canonicalId: 'twitchcanon1', created: false });
  assert.ok(!pool.seen.some((q) => /INSERT INTO stream\.users/.test(q.sql)), 'no second identity');
  assert.ok(!pool.seen.some((q) => /UPDATE stream\.users SET name/.test(q.sql)), 'their stream name stays');
  // The person gets their OWN native row on that canonical, so unlinking
  // the platform account later separates it instead of leaving it holding the site identity.
  const link = pool.seen.find((q) => /INSERT INTO stream\.links/.test(q.sql));
  assert.ok(link, 'no native row was written for a platform-linked person');
  assert.deepEqual(link.params, [NATIVE_PLATFORM, '@t:site.test', 'twitchcanon1']);
  assert.match(link.sql, /ON CONFLICT DO NOTHING/, 'a retried sign-in must not throw on the row the first one wrote');
});

test('a brand-new person is created with the name given and a native link', async () => {
  const app = fakeApp();
  const pool = poolWith('none', null);
  const id = createIdentity({ pool, requestAggregateRefresh: () => {} });
  id.registerIdentityRoutes(app, { requireInternal, wrap });
  const [, handler] = app.routes.get('POST /identity/resolve');
  const res = fakeRes();
  await handler({ body: { platform: NATIVE_PLATFORM, userId: '@n:site.test', username: 'Newbie' } }, res);
  assert.equal(res.code, 200);
  assert.match(res.body.canonicalId, /^[0-9a-f]{12}$/);
  const created = pool.seen.find((q) => /INSERT INTO stream\.users/.test(q.sql));
  assert.deepEqual(created.params.slice(0, 2), [res.body.canonicalId, 'Newbie']);
  const link = pool.seen.find((q) => /INSERT INTO stream\.links/.test(q.sql));
  assert.deepEqual(link.params, [NATIVE_PLATFORM, '@n:site.test', res.body.canonicalId]);
});

test('resolve refuses a body missing any of the three fields', async () => {
  const app = fakeApp();
  const id = createIdentity({ pool: poolWithLink('x'), requestAggregateRefresh: () => {} });
  id.registerIdentityRoutes(app, { requireInternal, wrap });
  const [, handler] = app.routes.get('POST /identity/resolve');
  for (const body of [{}, { platform: NATIVE_PLATFORM, userId: '@k:site.test' }, { platform: NATIVE_PLATFORM, userId: '', username: 'k' }, null]) {
    const res = fakeRes();
    await handler({ body }, res);
    assert.equal(res.code, 400, JSON.stringify(body));
  }
});
