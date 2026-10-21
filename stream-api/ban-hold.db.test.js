// Against a REAL Postgres: ban-hold.js's three statements (a mock pool cannot reject illegal SQL).
//   • the rebuild reads site.bans through BOTH link tables (platform_links + the account's native
//     stream.links row) and holds only unexpired bans;
//   • it reads site.mod_log's LAST ban-or-unban per canonical target, inside the bridge window only;
//   • a push by matrix id resolves that account's canonicals.
// Fixtures are scoped to ids beginning `ba0` / `@bh-` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test ban-hold.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createBanHold } = require('./ban-hold');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const CASEY = '@bh-casey:site.test';   // site-banned, two linked identities
const DANA = '@bh-dana:site.test';     // ban expired
const quiet = { warn() {}, log() {}, error() {} };

test('ban-hold reads and resolves against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.mod_log WHERE target_id LIKE 'ba0%' OR performed_by LIKE '@bh-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id LIKE '@bh-%'`);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id LIKE '@bh-%'`);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE '@bh-%' OR platform_id LIKE 'bh-%'`);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'ba0%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@bh-%'`);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  for (const m of [CASEY, DANA, '@bh-mod:site.test']) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  for (const id of ['ba0000000001', 'ba0000000002', 'ba0000000003', 'ba0000000004', 'ba0000000005', 'ba0000000006'])
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  // casey: a Kick identity through platform_links, her own native identity through stream.links.
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', 'bh-k1', 'ba0000000001')`, [CASEY]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, 'ba0000000002')`, [CASEY]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'bh-t1', 'ba0000000003')`, [DANA]);
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, '@bh-mod:site.test', NULL)`, [CASEY]);
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, '@bh-mod:site.test', now() - interval '1 minute')`, [DANA]);
  // Platform-only chatters, by mod_log: 4 banned a minute ago; 5 banned then unbanned; 6 banned an hour ago.
  const log = (target, action, ago) => pool.query(
    `INSERT INTO site.mod_log (action, target_id, performed_by, created_at) VALUES ($1, $2, '@bh-mod:site.test', now() - make_interval(secs => $3))`,
    [action, target, ago]);
  await log('ba0000000004', 'ban', 60);
  await log('ba0000000005', 'ban', 120);
  await log('ba0000000005', 'unban', 30);
  await log('ba0000000006', 'ban', 3600);

  const hold = createBanHold({ pool, log: quiet });
  await hold.refresh();
  const held = (id) => hold.isHeld(id);
  assert.equal(held('ba0000000001'), true, 'a site ban did not hold the linked Kick identity');
  assert.equal(held('ba0000000002'), true, 'a site ban did not hold the account\'s own native identity');
  assert.equal(held('ba0000000003'), false, 'an expired site ban held');
  assert.equal(held('ba0000000004'), true, 'a platform-only ban inside the bridge was not held');
  assert.equal(held('ba0000000005'), false, 'a ban followed by an unban was held');
  assert.equal(held('ba0000000006'), false, 'a platform-only ban past the bridge was held');

  // A push by matrix id resolves through the same tables (the unban, then the ban again).
  const routes = {};
  hold.registerBanHoldRoutes({ post: (p, ...h) => { routes[p] = h.at(-1); } }, { requireInternal: null, wrap: (fn) => fn });
  const push = async (body) => { let out; await routes['/chat/ban']({ body }, { status() { return this; }, json(b) { out = b; } }); return out; };
  assert.deepEqual(await push({ matrixIds: [CASEY], lift: true }), { ok: true, lifted: true, identities: 2 });
  assert.equal(held('ba0000000001'), false);
  assert.equal(held('ba0000000002'), false);
  assert.deepEqual(await push({ matrixIds: [CASEY], expiresAt: new Date(Date.now() + 60_000).toISOString() }), { ok: true, lifted: false, identities: 2 });
  assert.equal(held('ba0000000001'), true);
});
