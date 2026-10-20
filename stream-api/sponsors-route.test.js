// GET /sponsors/clock — the earn path's question: is this viewer's sponsor
// clock lit? Drives the real register function against
// a fake app, the same way timer-night-route.test.js drives money's.
//
// Run: node --test sponsors-route.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSponsors } = require('./sponsors');

function fakeApp() {
  const routes = {};
  const reg = (prefix) => (path, ...h) => { routes[`${prefix}${path}`] = { middleware: h.slice(0, -1), handler: h[h.length - 1] }; };
  return { routes, get: reg(''), post: reg('POST ') };
}
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function poolWith(links, seen = []) {
  return {
    query: async (sql, params) => {
      seen.push({ sql, params });
      if (/WHERE matrix_id = \$1/.test(sql)) return { rows: (links[params[0]] || []).map((id) => ({ id })) };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
function harness({ links = {}, elapsedSec = 1000 } = {}) {
  const seen = [];
  const sponsors = createSponsors({
    pool: poolWith(links, seen), broadcast: () => {},
    timer: { snapshot: () => ({ night: { active: true, elapsedSec }, usdPerHour: 0 }) },
    getStreamId: async () => 'S1',
  });
  const app = fakeApp();
  const requireInternal = (req, res, next) => next();
  sponsors.registerSponsorRoutes(app, { requireInternal, wrap: (fn) => fn });
  const route = app.routes['/sponsors/clock'];
  const get = async (query) => { const res = fakeRes(); await route.handler({ query }, res); return res; };
  return { sponsors, route, get, requireInternal, seen };
}

test('GET /sponsors/clock is registered behind requireInternal', () => {
  const h = harness();
  assert.ok(h.route, 'route missing');
  assert.ok(h.route.middleware.includes(h.requireInternal), 'the clock route must be internal — web asks it with the shared secret');
});

test('a malformed matrixId is a 400, and no query runs', async () => {
  for (const bad of [undefined, '', 'eddy', '@eddy', '@eddy site.test', ['@a:b'], 42]) {
    const h = harness();
    const res = await h.get({ matrixId: bad });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
    assert.deepEqual(res.body, { error: 'bad matrixId' });
    assert.equal(h.seen.length, 0, 'a bad id must not reach the database');
  }
});

test('an unknown matrix id (no canonical yet) is simply inactive', async () => {
  const h = harness();
  assert.deepEqual((await h.get({ matrixId: '@nobody:site.test' })).body, { ok: true, active: false, remainSec: 0 });
  assert.match(h.seen[0].sql, /site\.platform_links[\s\S]*UNION[\s\S]*stream\.links WHERE platform IN \('native'[^)]*\)/,
    'both identity joins — OAuth-linked platform accounts AND the native account itself');
  assert.deepEqual(h.seen[0].params, ['@nobody:site.test']);
});

test('a lit clock answers active with the seconds left; once expired it answers inactive', async () => {
  const h = harness({ links: { '@eddy:site.test': ['a60500127435'] }, elapsedSec: 1000 });
  h.sponsors.__test.state.set('u:a60500127435', { name: 'Gadget Qorm', aliases: new Map(), weightSec: 100, clockUntilElapsed: 1600, clockStartElapsed: 1000 });
  assert.deepEqual((await h.get({ matrixId: '@eddy:site.test' })).body, { ok: true, active: true, remainSec: 600 });
  h.sponsors.__test.state.get('u:a60500127435').clockUntilElapsed = 900;
  assert.deepEqual((await h.get({ matrixId: '@eddy:site.test' })).body, { ok: true, active: false, remainSec: 0 });
});

test('an unmerged split: ANY live canonical lights the clock, remainSec is the max', async () => {
  const h = harness({ links: { '@cleo:site.test': ['c1', 'c2'] }, elapsedSec: 1000 });
  h.sponsors.__test.state.set('u:c1', { name: 'cleo', aliases: new Map(), weightSec: 1, clockUntilElapsed: 900,  clockStartElapsed: 100 });
  h.sponsors.__test.state.set('u:c2', { name: 'cleo', aliases: new Map(), weightSec: 1, clockUntilElapsed: 1300, clockStartElapsed: 1000 });
  assert.deepEqual((await h.get({ matrixId: '@cleo:site.test' })).body, { ok: true, active: true, remainSec: 300 });
});

test('the id is trimmed, and a query-string array is refused rather than coerced', async () => {
  const h = harness({ links: { '@eddy:site.test': [] } });
  assert.equal((await h.get({ matrixId: '  @eddy:site.test ' })).statusCode, 200);
  assert.equal((await h.get({ matrixId: ['@eddy:site.test', '@x:y'] })).statusCode, 400);
});

test('POST /sponsors/links-changed is internal and answers once the pool is rebuilt', async () => {
  const sent = [];
  const sponsors = createSponsors({
    pool: { query: async () => ({ rows: [] }) }, broadcast: (f) => sent.push(f),
    timer: { snapshot: () => ({ night: { active: false, elapsedSec: 0 }, usdPerHour: 0 }) },
    getStreamId: async () => null,
  });
  const app = fakeApp();
  const requireInternal = (req, res, next) => next();
  sponsors.registerSponsorRoutes(app, { requireInternal, wrap: (fn) => fn });
  const route = app.routes['POST /sponsors/links-changed'];
  assert.ok(route, 'route missing');
  assert.deepEqual(route.middleware, [requireInternal]);
  const res = fakeRes();
  await route.handler({ body: {} }, res);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(sent.at(-1)?.type, 'sponsorState', 'the rebuild emits a fresh frame before the route answers');
});
