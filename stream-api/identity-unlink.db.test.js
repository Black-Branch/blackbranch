// Against a REAL Postgres: the ONE-preferred-identity tie-break and POST /identity/unlink.
//   • resolveCanonical with no native row and two platform links answers the LOWEST canonical id,
//     every time — the order web's canonicalFromMatrix uses.
//   • /identity/unlink moves exactly one stream.links row to a fresh canonical, leaves the sibling
//     rows where they were, makes the identity cache forget that platform id, and is idempotent.
// Fixtures are scoped to ids beginning `g1u` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test identity-unlink.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const ME = '@g1u-casey:site.test';

test('identity tie-break and unlink against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => serially(pool, async () => {
    const minted = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE 'g1u-%' OR platform_id LIKE '@g1u-%'`)).rows.map((r) => r.canonical);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1 OR matrix_id LIKE '@g1u-%'`, [ME]);
    await pool.query(`DELETE FROM site.user_marks WHERE canonical_id LIKE 'g1u%' OR canonical_id = ANY($1) OR platform_user LIKE 'g1u-%'`, [minted]);
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'g1u-%'`);
    await pool.query(`DELETE FROM site.user_marks WHERE matrix_id LIKE '@g1u-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id LIKE '@g1u-%' OR banned_by LIKE '@g1u-%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@g1u-%'`);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE 'g1u-%' OR platform_id LIKE '@g1u-%' OR canonical LIKE 'g1u%'`);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id LIKE 'g1u%' OR user_id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical LIKE 'g1u%' OR canonical = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'g1u%' OR id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [ME]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'casey')`, [ME]);
  for (const id of ['g1ub', 'g1ua', 'g1uc']) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'casey')`, [id]);

  await t.test('no native row, two platform links: the LOWEST canonical id, on every call', async () => {
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES
      ($1, 'twitch', 'g1u-tw', 'g1ub'), ($1, 'youtube', 'g1u-yt', 'g1ua')`, [ME]);
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    for (let i = 0; i < 5; i++) assert.equal(await identity.resolveCanonical(null, ME), 'g1ua');
    // A native row still wins over both.
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1uc')`, [ME]);
    assert.equal(await identity.resolveCanonical(null, ME), 'g1uc');
    await pool.query(`DELETE FROM stream.links WHERE platform = 'native' AND platform_id = $1`, [ME]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [ME]);
  });

  await t.test('unlink moves only that one link to a fresh canonical; siblings stay; the cache forgets; idempotent', async () => {
    // One merged person: the site row and two platform accounts on canonical g1ua.
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES
      ('native', $1, 'g1ua'), ('twitch', 'g1u-tw', 'g1ua'), ('kick', 'g1u-kk', 'g1ua')`, [ME]);
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    assert.equal(await identity.resolveOrCreate('twitch', 'g1u-tw', 'casey'), 'g1ua'); // now cached
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    const call = async (body) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/identity/unlink']({ body }, res);
      return res;
    };
    const first = await call({ matrixId: ME, platform: 'twitch', platformId: 'g1u-tw' });
    assert.equal(first.statusCode, 200);
    const fresh = first.body.canonicalId;
    assert.ok(fresh && fresh !== 'g1ua', 'no fresh canonical was minted');
    const links = Object.fromEntries((await pool.query(
      `SELECT platform, canonical FROM stream.links WHERE platform_id IN ($1, 'g1u-tw', 'g1u-kk')`, [ME])).rows.map((r) => [r.platform, r.canonical]));
    assert.deepEqual(links, { native: 'g1ua', twitch: fresh, kick: 'g1ua' }, 'a sibling link moved, or the unlinked one did not');
    assert.equal((await pool.query(`SELECT name FROM stream.users WHERE id = $1`, [fresh])).rows[0].name, 'g1u-tw',
      'the fresh identity must not carry the site person\'s name');
    assert.equal(await identity.resolveOrCreate('twitch', 'g1u-tw', 'casey'), fresh, 'the identity cache still answered the old canonical');
    const again = await call({ matrixId: ME, platform: 'twitch', platformId: 'g1u-tw' });
    assert.deepEqual(again.body, { ok: true, canonicalId: fresh, unchanged: true });
    assert.equal((await pool.query(`SELECT 1 FROM stream.links WHERE platform = 'twitch' AND platform_id = 'g1u-tw'`)).rowCount, 1);
  });

  // An unlink is never a way out of a restriction.
  await t.test('unlinking a MARKED identity: the fresh canonical carries the open mark', async () => {
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1um', 'marked')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', '@g1u-m:site.test', 'g1um'), ('twitch', 'g1u-mtw', 'g1um'), ('kick', 'g1u-mkk', 'g1um')`);
    await pool.query(`INSERT INTO site.user_marks (canonical_id, platform, platform_user, reason, source, created_by) VALUES ('g1um', 'twitch', 'g1u-mtw', 'spam run', 'automod', 'automod')`);
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/identity/unlink']({ body: { matrixId: '@g1u-m:site.test', platform: 'twitch', platformId: 'g1u-mtw' } }, res);
    assert.equal(res.statusCode, 200);
    const fresh = res.body.canonicalId;
    const mark = (await pool.query(`SELECT source, reason FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [fresh])).rows;
    assert.equal(mark.length, 1, 'the unlinked identity walked away from its mark');
    assert.equal(mark[0].source, 'carried');
    assert.match(mark[0].reason, /spam run/);
    assert.equal((await pool.query(`SELECT 1 FROM site.user_marks WHERE canonical_id = 'g1um' AND cleared_at IS NULL`)).rowCount, 1, 'the original mark must stay too');
  });

  await t.test('unlinking a platform id a deleted account left restricted: the fresh canonical is marked', async () => {
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1ur', 'r')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', '@g1u-r:site.test', 'g1ur'), ('twitch', 'g1u-rtw', 'g1ur')`);
    await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason) VALUES ('twitch', 'g1u-rtw', '@g1u-gone:site.test', 'ban')`);
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/identity/unlink']({ body: { matrixId: '@g1u-r:site.test', platform: 'twitch', platformId: 'g1u-rtw' } }, res);
    const mark = (await pool.query(`SELECT source, reason FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [res.body.canonicalId])).rows;
    assert.deepEqual(mark.map((m) => m.source), ['carried']);
    assert.match(mark[0].reason, /a ban/);
  });

  const unlinkAs = async (matrixId, platform, platformId) => {
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/identity/unlink']({ body: { matrixId, platform, platformId } }, res);
    return res;
  };

  await t.test('an ACCOUNT-keyed mark (matrix_id, no canonical) is carried too', async () => {
    const who = '@g1u-acct:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'acct')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1ua2', 'acct')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1ua2'), ('twitch', 'g1u-atw', 'g1ua2')`, [who]);
    await pool.query(`INSERT INTO site.user_marks (matrix_id, reason, source, created_by) VALUES ($1, 'account mark', 'mod', 'mod')`, [who]);
    const res = await unlinkAs(who, 'twitch', 'g1u-atw');
    assert.equal(res.statusCode, 200);
    const mark = (await pool.query(`SELECT source, reason FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [res.body.canonicalId])).rows;
    assert.equal(mark.length, 1, 'an account-level mark did not follow the unlinked identity');
    assert.match(mark[0].reason, /account mark/);
  });

  await t.test('an active site ban of the account is carried as a mark', async () => {
    const who = '@g1u-banned:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'banned')`, [who]);
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ('@g1u-mod:site.test', 'mod') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, reason) VALUES ($1, '@g1u-mod:site.test', 'abuse')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1ub2', 'banned')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1ub2'), ('twitch', 'g1u-btw', 'g1ub2')`, [who]);
    const res = await unlinkAs(who, 'twitch', 'g1u-btw');
    const mark = (await pool.query(`SELECT source, reason FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [res.body.canonicalId])).rows;
    assert.deepEqual(mark.map((m) => m.source), ['carried'], 'a banned account unlinked a platform identity away from its ban');
    assert.match(mark[0].reason, /site ban/);
  });

  await t.test('an EXPIRED ban carries nothing', async () => {
    const who = '@g1u-expired:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'exp')`, [who]);
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ('@g1u-mod:site.test', 'mod') ON CONFLICT DO NOTHING`);
    await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, reason, expires_at) VALUES ($1, '@g1u-mod:site.test', 'old', NOW() - interval '1 day')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1ue2', 'exp')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1ue2'), ('twitch', 'g1u-etw', 'g1ue2')`, [who]);
    const res = await unlinkAs(who, 'twitch', 'g1u-etw');
    assert.equal((await pool.query(`SELECT 1 FROM site.user_marks WHERE canonical_id = $1`, [res.body.canonicalId])).rowCount, 0);
  });

  await t.test('unlink refuses a link that is not this account\'s, and a missing one', async () => {
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1ux', 'x')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'g1u-other', 'g1ux'), ('kick', 'g1u-other2', 'g1ux')`);
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    const call = async (body) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/identity/unlink']({ body }, res);
      return res;
    };
    assert.equal((await call({ matrixId: ME, platform: 'twitch', platformId: 'g1u-other' })).statusCode, 409);
    assert.equal((await pool.query(`SELECT canonical FROM stream.links WHERE platform_id = 'g1u-other'`)).rows[0].canonical, 'g1ux');
    assert.equal((await call({ matrixId: ME, platform: 'twitch', platformId: 'g1u-none' })).statusCode, 404);
    assert.equal((await call({ matrixId: ME, platform: 'native', platformId: ME })).statusCode, 400);
  });

  // ── the ONE-link person. A site person with no native stream.links row whose site chat sits on
  // the canonical their only platform link gave them (resolveCanonical's prio 2). An unlink that
  // sees that link alone on its canonical and answers { unchanged: true } leaves the platform
  // account holding the site person's canonical once web drops its rows, and the next site account
  // to claim that platform account merges two people. Each case runs its original path, a restart
  // and a retry.
  const routesOf = (identity) => {
    const routes = {};
    identity.registerIdentityRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; }, get: () => {} },
      { requireInternal: (_q, _s, n) => n(), wrap: (fn) => fn });
    return routes;
  };
  const hit = async (routes, path, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes[path]({ body }, res);
    return res;
  };
  // One site person, ONE platform link, no native row.
  const oneLinkPerson = async (who, canon, pid) => {
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'casey')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'casey')`, [canon]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', $1, $2)`, [pid, canon]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3)`, [who, pid, canon]);
  };
  const nativeRows = async (who) => (await pool.query(
    `SELECT canonical FROM stream.links WHERE platform = 'native' AND platform_id = $1`, [who])).rows.map((r) => r.canonical);
  // What web's unlinkPlatformAccount does once stream-api has answered.
  const webDropsRows = (who) => pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1 AND platform = 'twitch'`, [who]);
  const fresh = () => createIdentity({ pool, requestAggregateRefresh: () => {} });
  const unlinkBody = (who, pid) => ({ matrixId: who, platform: 'twitch', platformId: pid });

  await t.test('original path: one link, no native row — unlink SEPARATES, and the site person keeps their canonical through a native row', async () => {
    const who = '@g1u-one:site.test';
    await oneLinkPerson(who, 'g1uo', 'g1u-otw');
    const identity = fresh();
    assert.equal(await identity.resolveCanonical(null, who), 'g1uo', 'fixture: the site chat sits on the platform link\'s canonical');
    const res = await hit(routesOf(identity), '/identity/unlink', unlinkBody(who, 'g1u-otw'));
    assert.equal(res.statusCode, 200);
    const sep = res.body.canonicalId;
    assert.ok(sep && sep !== 'g1uo', 'the lone platform link stayed on the site person\'s canonical');
    assert.ok(!res.body.unchanged);
    assert.deepEqual(await nativeRows(who), ['g1uo'], 'the site person was not given their own native row on their canonical');
    assert.equal((await pool.query(`SELECT canonical FROM stream.links WHERE platform = 'twitch' AND platform_id = 'g1u-otw'`)).rows[0].canonical, sep);
    await webDropsRows(who);
    assert.equal(await identity.resolveCanonical(null, who), 'g1uo', 'the site person lost their identity');

    // The felt outcome: ANOTHER site account later claims that platform account and merges —
    // nothing of the first person's goes with it.
    const other = '@g1u-two:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'drew')`, [other]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1uq', 'drew')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1uq')`, [other]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'g1u-otw', $2)`, [other, sep]);
    const ids = await identity.gatherIdentity(other);
    assert.ok(!ids.includes('g1uo'), 'the second claimant still reaches the first person\'s canonical');
    await identity.mergeCanonicals(ids);
    assert.equal((await pool.query(`SELECT 1 FROM stream.users WHERE id = 'g1uo'`)).rowCount, 1, 'the first person was merged into the second');
    assert.equal(await identity.resolveCanonical(null, who), 'g1uo');
  });

  await t.test('restart: after the unlink, a restarted stream-api (empty cache) answers the same people', async () => {
    const who = '@g1u-rs:site.test';
    await oneLinkPerson(who, 'g1urs', 'g1u-rstw');
    const before = fresh();
    assert.equal(await before.resolveOrCreate('twitch', 'g1u-rstw', 'casey'), 'g1urs'); // cached in the old process
    const sep = (await hit(routesOf(before), '/identity/unlink', unlinkBody(who, 'g1u-rstw'))).body.canonicalId;
    assert.notEqual(sep, 'g1urs');
    await webDropsRows(who);
    const after = fresh(); // the restart
    assert.equal(await after.resolveCanonical(null, who), 'g1urs');
    assert.equal(await after.resolveOrCreate('twitch', 'g1u-rstw', 'casey'), sep);
    const signIn = await hit(routesOf(after), '/identity/resolve', { platform: 'native', userId: who, username: 'casey' });
    assert.deepEqual(signIn.body, { ok: true, canonicalId: 'g1urs', created: false });
    assert.deepEqual(await nativeRows(who), ['g1urs']);
  });

  await t.test('retry: web failed after stream-api committed — the retry (after a restart) answers unchanged and mints nothing', async () => {
    const who = '@g1u-rt:site.test';
    await oneLinkPerson(who, 'g1urt', 'g1u-rttw');
    const sep = (await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-rttw'))).body.canonicalId;
    assert.notEqual(sep, 'g1urt');
    // web's row deletes never ran: site.platform_links still says twitch → g1urt.
    // Scoped to this file's fixture identities (the cleanup's own scope): every id that starts g1u or
    // is linked to a g1u- platform id or an @g1u- site account. A count of EVERY stream.users row
    // raced other test files inserting people in parallel (measured: 2-5 failures in 8 runs).
    const fixtureUsers = async () => Number((await pool.query(
      `SELECT COUNT(*) AS n FROM stream.users WHERE id LIKE 'g1u%'
          OR id IN (SELECT canonical FROM stream.links WHERE platform_id LIKE 'g1u-%' OR platform_id LIKE '@g1u-%')`)).rows[0].n);
    const users = await fixtureUsers();
    assert.ok(users >= 2, `vacuity: the scoped count sees the fixture (${users})`);
    for (let i = 0; i < 2; i++) {
      const again = await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-rttw'));
      assert.equal(again.statusCode, 200);
      assert.deepEqual(again.body, { ok: true, canonicalId: sep, unchanged: true });
    }
    assert.equal(await fixtureUsers(), users, 'a retry minted another identity');
    assert.deepEqual(await nativeRows(who), ['g1urt']);
    await webDropsRows(who);
    assert.equal(await fresh().resolveCanonical(null, who), 'g1urt');
  });

  await t.test('retry: a stream-api transaction that FAILS midway leaves nothing — no native row, link in place — and the retry separates', async () => {
    const who = '@g1u-mid:site.test';
    await oneLinkPerson(who, 'g1umd', 'g1u-mdtw');
    let armed = true;
    const flaky = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const c = await pool.connect();
        return {
          query: (sql, params) => {
            if (armed && /^UPDATE stream\.links SET canonical/.test(sql)) { armed = false; return Promise.reject(new Error('connection lost')); }
            return c.query(sql, params);
          },
          release: () => c.release(),
        };
      },
    };
    await assert.rejects(hit(routesOf(createIdentity({ pool: flaky, requestAggregateRefresh: () => {} })), '/identity/unlink',
      unlinkBody(who, 'g1u-mdtw')), /connection lost/);
    assert.ok(!armed, 'the failure was never injected — this test proves nothing');
    assert.deepEqual(await nativeRows(who), [], 'a failed unlink left a half-made native row');
    assert.equal((await pool.query(`SELECT canonical FROM stream.links WHERE platform_id = 'g1u-mdtw'`)).rows[0].canonical, 'g1umd');
    const retry = await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-mdtw'));
    assert.equal(retry.statusCode, 200);
    assert.ok(retry.body.canonicalId !== 'g1umd' && !retry.body.unchanged, 'the retry did not separate');
    assert.deepEqual(await nativeRows(who), ['g1umd']);
  });

  await t.test('a lone link that is NOT this account\'s: still answered unchanged, and no native row is minted for the caller', async () => {
    const who = '@g1u-stranger:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 's')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1uls', 'x')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'g1u-lone', 'g1uls')`);
    const res = await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-lone'));
    assert.deepEqual(res.body, { ok: true, canonicalId: 'g1uls', unchanged: true });
    assert.deepEqual(await nativeRows(who), []);
  });

  await t.test('a split person (own native row elsewhere) whose platform canonical holds only that link: unchanged, no second native row', async () => {
    const who = '@g1u-split:site.test';
    await oneLinkPerson(who, 'g1usp', 'g1u-sptw');
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1usn', 'casey')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'g1usn')`, [who]);
    const res = await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-sptw'));
    assert.deepEqual(res.body, { ok: true, canonicalId: 'g1usp', unchanged: true });
    assert.deepEqual(await nativeRows(who), ['g1usn']);
  });

  // /identity/resolve (every site sign-in) gives a platform-linked person their native row, so the
  // person's site identity is their own and not borrowed from a platform account they may unlink.
  await t.test('resolve: a one-link person gets a native row on the canonical they already resolve to — retry and restart answer the same; a later unlink separates', async () => {
    const who = '@g1u-res:site.test';
    await oneLinkPerson(who, 'g1urv', 'g1u-rvtw');
    for (let i = 0; i < 3; i++) { // the first sign-in, a retry, and sign-ins after a restart: a fresh instance each time
      const res = await hit(routesOf(fresh()), '/identity/resolve', { platform: 'native', userId: who, username: 'renamed' });
      assert.deepEqual(res.body, { ok: true, canonicalId: 'g1urv', created: false });
    }
    assert.deepEqual(await nativeRows(who), ['g1urv']);
    assert.equal((await pool.query(`SELECT name FROM stream.users WHERE id = 'g1urv'`)).rows[0].name, 'casey', 'a returning person was renamed');
    const res = await hit(routesOf(fresh()), '/identity/unlink', unlinkBody(who, 'g1u-rvtw'));
    assert.ok(res.body.canonicalId !== 'g1urv' && !res.body.unchanged, 'the unlink did not separate');
  });

  await t.test('resolve: a platform link pointing at a canonical that no longer exists mints no native row and does not throw', async () => {
    const who = '@g1u-stale:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 's')`, [who]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'g1u-sttw', 'g1ugone')`, [who]);
    const res = await hit(routesOf(fresh()), '/identity/resolve', { platform: 'native', userId: who, username: 's' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await nativeRows(who), []);
  });
});
