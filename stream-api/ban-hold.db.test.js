// Against a REAL Postgres: ban-hold.js's three statements (a mock pool cannot reject illegal SQL).
//   • the rebuild reads site.bans through BOTH link tables (platform_links + the account's native
//     stream.links row) and holds only unexpired bans;
//   • it reads each canonical's standing (config/canonical-standing.mjs), inside the bridge window only;
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

// A3-01: the ban is keyed on the platform id as well as the canonical. Deleting the account takes
// the platform account off its canonical (account-erase.js deletes the identity; the next line mints
// a fresh one) and keeps the ban only in stream.erased_restrictions; the hold must still stop the
// platform id — before a rebuild (from the platform id it already held) and after one (from the
// restriction), and in a fresh process (a restart) the same.
test('a banned account\'s platform id stays held after an unlink and after deletion, and after a rebuild', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const GONE = '@bh-gone:site.test';
  const MOD = '@bh-mod3:site.test';
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'bh3-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id = $1`, [GONE]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [GONE]);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE 'bh3-%' OR platform_id = $1`, [GONE]);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'bb3%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [[GONE, MOD]]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  for (const m of [GONE, MOD]) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  for (const id of ['bb3000000001', 'bb3000000002', 'bb3000000003']) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('kick', 'bh3-k1', 'bb3000000001')`);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', 'bh3-k1', 'bb3000000001')`, [GONE]);
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, NULL)`, [GONE, MOD]);

  const hold = createBanHold({ pool, log: quiet });
  await hold.refresh();
  assert.equal(hold.isHeld('bb3000000001', 'kick', 'bh3-k1'), true, 'the linked Kick identity is not held while linked');

  // Unlink is refused while the ban runs (web platformUnlink.ts); stream-api's half alone would move
  // the platform account to a fresh canonical — its platform id is still the banned account's.
  await pool.query(`UPDATE stream.links SET canonical = 'bb3000000002' WHERE platform = 'kick' AND platform_id = 'bh3-k1'`);
  assert.equal(hold.isHeld('bb3000000002', 'kick', 'bh3-k1'), true, 'a fresh canonical of the banned platform id was let through before a rebuild');
  await hold.refresh();
  assert.equal(hold.isHeld('bb3000000002', 'kick', 'bh3-k1'), true, 'a fresh canonical of the banned platform id was let through after a rebuild');

  // Deletion, as account-erase.js leaves a banned account: the restriction on the platform id, the
  // links and the canonical gone, site.bans kept for the account.
  await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason) VALUES ('kick', 'bh3-k1', $1, 'ban')`, [GONE]);
  await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [GONE]);
  await pool.query(`DELETE FROM stream.links WHERE platform = 'kick' AND platform_id = 'bh3-k1'`);
  // The next line from that Kick id mints a fresh identity.
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('kick', 'bh3-k1', 'bb3000000003')`);
  assert.equal(hold.isHeld('bb3000000003', 'kick', 'bh3-k1'), true, 'after deletion, before a rebuild, the platform id was let through');
  await hold.refresh();
  assert.equal(hold.isHeld('bb3000000003', 'kick', 'bh3-k1'), true, 'after deletion and a rebuild, the platform id was let through');
  assert.equal(hold.isHeld('bb3000000003'), true, 'the fresh canonical itself is not held after a rebuild (the stream.links join)');

  // A restart: a fresh hold built from the database alone. A retry: the same rebuild twice.
  const restarted = createBanHold({ pool, log: quiet });
  await restarted.refresh();
  assert.equal(restarted.isHeld('bb3000000003', 'kick', 'bh3-k1'), true, 'a restarted process let the deleted account\'s platform id through');
  await restarted.refresh();
  assert.equal(restarted.isHeld('bb3000000003', 'kick', 'bh3-k1'), true, 'a second rebuild changed the answer');

  // The ban lifted (web's LIFT_BAN_SQL deletes the site.bans row): the next rebuild lets them chat
  // again, whatever the restriction row still says.
  await pool.query(`DELETE FROM site.bans WHERE matrix_id = $1`, [GONE]);
  await restarted.refresh();
  assert.equal(restarted.isHeld('bb3000000003', 'kick', 'bh3-k1'), false, 'a lifted ban still held the platform id');
  assert.equal(restarted.isHeld('bb3000000003'), false, 'a lifted ban still held the canonical');
});

// Round 1 (reviewer): a deleted account's TIMEOUT is recorded as a 'ban' restriction too, and with
// an open case that restriction runs 30 days (or, written before c73b02e4, forever: expires_at NULL).
// The chat hold reads the BAN's own end (site.bans), never the restriction's — a 10-minute timeout
// never becomes a month-long chat block.
test('a deleted timeout never holds chat past the timeout\'s end', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const T1 = '@bh-to1:site.test', T2 = '@bh-to2:site.test', MOD = '@bh-mod4:site.test';
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'bh4-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id = ANY($1)`, [[T1, T2]]);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE 'bh4-%'`);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'bb4%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [[T1, T2, MOD]]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  for (const m of [T1, T2, MOD]) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  for (const id of ['bb4000000001', 'bb4000000002']) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'bh4-t1', 'bb4000000001'), ('twitch', 'bh4-t2', 'bb4000000002')`);
  // T1: a 10-minute timeout + an open case at deletion → a 'ban' restriction running 30 days.
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [T1, MOD]);
  await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason, expires_at)
                    VALUES ('twitch', 'bh4-t1', $1, 'ban', now() + interval '30 days')`, [T1]);
  // T2: the same, written by the code before this round — no end at all.
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, now() + interval '10 minutes')`, [T2, MOD]);
  await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason, expires_at)
                    VALUES ('twitch', 'bh4-t2', $1, 'ban', NULL)`, [T2]);

  const hold = createBanHold({ pool, log: quiet });
  await hold.refresh();
  assert.equal(hold.isHeld('bb4000000001', 'twitch', 'bh4-t1'), true, 'a running timeout of a deleted account was not held');
  assert.equal(hold.isHeld('bb4000000002', 'twitch', 'bh4-t2'), true);

  // The timeouts end. The restrictions (30 days; none) do not — the hold must.
  await pool.query(`UPDATE site.bans SET expires_at = now() - interval '1 second' WHERE matrix_id = ANY($1)`, [[T1, T2]]);
  for (const h of [hold, createBanHold({ pool, log: quiet })]) {   // the running process, and a restart
    await h.refresh();
    await h.refresh();                                              // a retry of the rebuild
    for (const [c, pid] of [['bb4000000001', 'bh4-t1'], ['bb4000000002', 'bh4-t2']]) {
      assert.equal(h.isHeld(c, 'twitch', pid), false, `${pid}: a deleted account's ended timeout still blocked chat`);
      assert.equal(h.isHeld(c), false, `${pid}: the canonical is still held`);
    }
  }
});
