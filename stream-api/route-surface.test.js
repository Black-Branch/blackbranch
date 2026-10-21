// ROUTE-SURFACE CONTRACT.
//
// WHAT THIS PROTECTS. stream-api's HTTP surface — every route, and the auth
// middleware guarding it — frozen in route-surface.snapshot.json. The failure
// mode it exists for is not a crash: it is a route quietly losing
// `requireInternal`, or vanishing, while the process still boots and every
// other test still passes. The money endpoints (/chat/event, /support,
// /timer/*) and the mod endpoints live on this surface.
//
// The extractor scans every stream-api source file and the snapshot excludes
// the filename on purpose — so moving a route from index.js into a
// registerX(app, deps) module is a NO-OP here, while losing or de-authing one
// is a loud failure. That is exactly the discrimination a refactor needs.
//
// This is a static scan of source, for the same reason money-policy.test.js is:
// the app cannot be booted in a test (Postgres, OBS, TTS, platform tokens).
//
// WHEN IT FAILS. Read the diff. If you deliberately added, removed, renamed or
// re-authed a route, regenerate:
//
//   node -e "const{surface,shadowPairs}=require('./routeSurface.js');\
//   require('node:fs').writeFileSync('route-surface.snapshot.json',\
//   JSON.stringify({...require('./route-surface.snapshot.json'),\
//   routes:surface(__dirname),shadowPairs:shadowPairs(__dirname)},null,2)+'\n')"
//
// …and make the regeneration its own reviewable line in the diff. NEVER
// regenerate to make a red suite green during a refactor — the whole value of
// this file is that the table does NOT change.
//
// Run: node --test route-surface.test.js

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { existsSync } = require('node:fs');
const { surface, surfaceByOrigin, shadowPairs, collectRoutes, moduleSurfaces } = require('./routeSurface.js');
const { MODULES } = require('./instanceSchema.generated.js');

const snapshot = JSON.parse(readFileSync(join(__dirname, 'route-surface.snapshot.json'), 'utf8'));

// The snapshot is the private build's whole surface: the product's routes plus the site plugin's
// (`owner`). A public tree has no owner folder, so it must hold exactly the product half.
const OWNER_PRESENT = existsSync(join(__dirname, 'owner'));
const expectedRoutes = OWNER_PRESENT ? snapshot.routes : snapshot.routes.filter((r) => !snapshot.owner.includes(r));
const ownerModuleIds = new Set(MODULES.filter((m) => m.kind === 'owner').map((m) => m.id));
const expectedModules = OWNER_PRESENT ? snapshot.modules
  : Object.fromEntries(Object.entries(snapshot.modules).filter(([id]) => !ownerModuleIds.has(id)));

test('the route surface matches the frozen contract', () => {
  const now = surface(__dirname);
  const was = expectedRoutes;

  // Report the delta in both directions — a bare deepEqual on 87 strings is
  // unreadable, and the point of this test is that the diff is obvious.
  const added = now.filter((r) => !was.includes(r));
  const removed = was.filter((r) => !now.includes(r));

  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    'the HTTP surface changed. A route moving between FILES is invisible here by ' +
    'design, so this means a route was added, deleted, renamed, or its auth ' +
    'middleware changed. During a refactor that is a defect, not a diff to accept.'
  );
});

test('no route silently loses its auth middleware', () => {
  // The single most dangerous regression on this surface, called out separately
  // so the failure message names it rather than burying it in a list diff.
  const wasPublic = new Set(
    snapshot.routes.filter((l) => l.includes('[PUBLIC]')).map((l) => l.split(' [')[0])
  );
  const nowPublic = surface(__dirname)
    .filter((l) => l.includes('[PUBLIC]'))
    .map((l) => l.split(' [')[0]);

  const newlyPublic = nowPublic.filter((r) => !wasPublic.has(r));
  assert.deepEqual(newlyPublic, [],
    `these routes are now UNAUTHENTICATED and were not before: ${newlyPublic.join(', ')}. ` +
    'stream-api is reachable from a peer host and the public tunnel — see requireInternal.');
});

test('shadowing order stays fixed (currently: nothing shadows anything)', () => {
  // Express matches first-registered-wins, so when a literal path and a :param
  // path collide at the same depth their ORDER is behaviour. There are none
  // today, which is why moving routes around is safe — but if a
  // future route creates a pair, its order becomes load-bearing and gets frozen
  // here rather than discovered in production.
  assert.deepEqual(shadowPairs(__dirname), snapshot.shadowPairs,
    'route shadowing changed — a literal and a :param path now collide, or their ' +
    'registration order flipped. First match wins in Express.');
});

test('the extractor actually sees the routes (guards against a silent zero)', () => {
  // A regex that stops matching would make every assertion above trivially pass
  // — the classic way a snapshot test rots into decoration.
  const routes = collectRoutes(__dirname);
  assert.ok(routes.length >= (OWNER_PRESENT ? 80 : 60), `found only ${routes.length} routes — the extractor is broken`);
  assert.ok(routes.some((r) => r.path === '/chat/event' && r.middleware.includes('requireInternal')),
    'the money endpoint is missing from the scan — the extractor is not seeing real routes');
});

test('per configuration: each module owns exactly the routes the snapshot lists for it', () => {
  // A switched-off module's routes are not mounted (modules.js), so a configuration's surface is
  // the full table minus the off modules' lines. The full table is the everything-on install;
  // the fresh-install (all owner modules off) count is pinned here so a module that grows a route
  // shows up as a reviewed change, not as drift.
  assert.ok(MODULES.length >= 4, `vacuity: only ${MODULES.length} manifests read`);
  for (const m of MODULES) {
    if (!OWNER_PRESENT && m.kind === 'owner') continue; // an owner module's files live in owner/
    for (const f of m.api.files) {
      assert.ok(existsSync(join(__dirname, f)) || existsSync(join(__dirname, 'owner', f)), `${m.id}'s manifest names ${f}, which does not exist`);
    }
  }
  const now = Object.fromEntries(Object.entries(moduleSurfaces(__dirname, MODULES)).filter(([id]) => OWNER_PRESENT || !ownerModuleIds.has(id)));
  assert.deepEqual(now, expectedModules,
    'a module gained, lost or re-authed a route (or a file moved between modules). Read the diff; ' +
    'update `modules` in route-surface.snapshot.json deliberately, never by regenerating to clear a red.');
  const all = surface(__dirname);
  const moduleLines = Object.values(now).flat();
  for (const l of moduleLines) assert.ok(all.includes(l), `${l} is a module route missing from the full surface`);
  // A fresh PUBLIC install: the product's routes only (no owner/ folder — the public export drops
  // it), minus the product modules that are off by default. Owner modules live in owner/, so
  // their routes are already outside the product set.
  const { product } = surfaceByOrigin(__dirname);
  const offProduct = MODULES.filter((m) => !m.defaultOn && m.kind !== 'owner').map((m) => m.id);
  const offLines = new Set(offProduct.flatMap((id) => now[id] || []));
  const freshInstall = product.filter((l) => !offLines.has(l)).length;
  assert.equal(freshInstall, snapshot.freshInstallRoutes,
    `a fresh public install (no owner folder; product modules off by default: ${offProduct.join(', ') || 'none'}) now mounts ${freshInstall} routes`);
});

test('the site plugin adds exactly the routes the snapshot lists for it; the rest is the product', () => {
  // owner/ is dropped by
  // the public export, so every route it carries leaves with it. Listed, so a route moving between
  // the product and the owner folder is a reviewed change in either direction.
  const { product, owner } = surfaceByOrigin(__dirname);
  if (!OWNER_PRESENT) {
    // A public tree: no owner route at all, and the product half exactly as the snapshot lists it.
    assert.deepEqual(owner, []);
    assert.deepEqual(product, snapshot.routes.filter((r) => !snapshot.owner.includes(r)));
    return;
  }
  assert.ok(owner.length > 0 && product.length > 0, `vacuity: product ${product.length}, owner ${owner.length}`);
  assert.deepEqual(owner, snapshot.owner,
    'a route moved into or out of owner/, or an owner route changed. Read the diff; update `owner` ' +
    'in route-surface.snapshot.json deliberately, never by regenerating to clear a red.');
  assert.deepEqual([...product, ...owner].sort(), surface(__dirname), 'the two halves do not add up to the full surface');
  // Every owner module's routes come from owner/ — an owner module with a product-side route
  // would survive the public export unmounted-but-present.
  for (const m of MODULES.filter((x) => x.kind === 'owner')) {
    for (const l of moduleSurfaces(__dirname, [m])[m.id] || []) assert.ok(owner.includes(l), `${m.id}: ${l} is not in owner/`);
  }
});
