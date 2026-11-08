// A deleted account's ban follows its platform ids (stream.erased_restrictions, v154), against a
// REAL Postgres:
//   • a fresh identity for a restricted platform id is written in ONE transaction with its mark —
//     a mark that cannot be written leaves no identity behind;
//   • a failed restriction lookup mints nothing;
//   • an identity holding a banned platform id is never merged into a new account (no claiming it
//     off the restriction);
//   • a later 'case' record never weakens a 'ban' or changes whose it is.
// Fixtures are scoped to ids beginning `g1r` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test identity-restriction.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const { createIdentity } = require('./identity');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; return Promise.resolve().then(fn).finally(() => { console.warn = w; console.log = l; }); };

test('erased_restrictions against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const clean = () => serially(pool, async () => {
    const minted = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE 'g1r-%'`)).rows.map((r) => r.canonical);
    await pool.query(`DELETE FROM site.user_marks WHERE platform_user LIKE 'g1r-%' OR canonical_id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'g1r-%'`);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE 'g1r-%' OR canonical = ANY($1) OR canonical LIKE 'g1r%'`, [minted]);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1) OR canonical LIKE 'g1r%'`, [minted]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1) OR user_id LIKE 'g1r%'`, [minted]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1) OR id LIKE 'g1r%'`, [minted]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason) VALUES ('twitch', 'g1r-banned', '@g1r-gone:site.test', 'ban')`);

  await t.test('a mark that cannot be written leaves NO identity behind (one transaction)', async () => {
    const failing = {
      query: (...a) => pool.query(...a),
      connect: async () => {
        const c = await pool.connect();
        return { query: (sql, p) => (/INSERT INTO site\.user_marks/.test(sql) ? Promise.reject(new Error('marks down')) : c.query(sql, p)), release: (e) => c.release(e) };
      },
    };
    const identity = createIdentity({ pool: failing, requestAggregateRefresh: () => {} });
    await assert.rejects(quiet(() => identity.resolveOrCreate('twitch', 'g1r-banned', 'evader')), /marks down/);
    assert.equal((await pool.query(`SELECT 1 FROM stream.links WHERE platform = 'twitch' AND platform_id = 'g1r-banned'`)).rowCount, 0,
      'an identity without its restriction was left behind');
  });

  await t.test('a failed restriction lookup mints nothing', async () => {
    const broken = { query: (sql, p) => (/erased_restrictions/.test(sql) ? Promise.reject(new Error('lookup down')) : pool.query(sql, p)), connect: () => pool.connect() };
    const identity = createIdentity({ pool: broken, requestAggregateRefresh: () => {} });
    await assert.rejects(quiet(() => identity.resolveOrCreate('twitch', 'g1r-unknown', 'someone')), /lookup down/);
    assert.equal((await pool.query(`SELECT 1 FROM stream.links WHERE platform_id = 'g1r-unknown'`)).rowCount, 0);
  });

  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  let fresh;
  await t.test('the platform id\'s next message: a fresh identity, marked, in one go', async () => {
    fresh = await quiet(() => identity.resolveOrCreate('twitch', 'g1r-banned', 'evader'));
    const mark = (await pool.query(`SELECT source FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [fresh])).rows;
    assert.deepEqual(mark, [{ source: 'carried' }]);
  });

  await t.test('a new account cannot merge the banned platform id\'s identity into itself', async () => {
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1rnew', 'newperson')`);
    const out = await quiet(() => identity.mergeCanonicals(['g1rnew', fresh]));
    assert.equal(out.merged, 0, 'the restricted identity was folded into a new account');
    assert.equal((await pool.query(`SELECT canonical FROM stream.links WHERE platform = 'twitch' AND platform_id = 'g1r-banned'`)).rows[0].canonical, fresh);
  });

  await t.test('a CASE record keeps an identity out of merges exactly like a ban', async () => {
    await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason) VALUES ('kick', 'g1r-case', '@g1r-gone2:site.test', 'case')`);
    const caseId = await quiet(() => identity.resolveOrCreate('kick', 'g1r-case', 'caseperson'));
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1rnew2', 'newperson2')`);
    const out = await quiet(() => identity.mergeCanonicals(['g1rnew2', caseId]));
    assert.equal(out.merged, 0, 'an identity under an open case was folded into a new account');
  });

  await t.test('a merge carries the victims\' open marks to the survivor — never clears a restriction', async () => {
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1rsurv', 's'), ('g1rvict', 'v'), ('g1rvic2', 'w')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'g1r-s', 'g1rsurv'), ('twitch', 'g1r-v', 'g1rvict'), ('twitch', 'g1r-w', 'g1rvic2')`);
    await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ('g1rsurv', 's', 100)`);
    await pool.query(`INSERT INTO site.user_marks (canonical_id, platform, platform_user, reason, source, evidence, created_by, created_at) VALUES
      ('g1rvict', 'twitch', 'g1r-v', 'earliest', 'automod', '{1,2}', 'automod', NOW() - interval '2 days'),
      ('g1rvic2', 'twitch', 'g1r-w', 'later', 'automod', '{3}', 'automod', NOW() - interval '1 day')`);
    const out = await quiet(() => identity.mergeCanonicals(['g1rsurv', 'g1rvict', 'g1rvic2']));
    assert.equal(out.survivor, 'g1rsurv');
    assert.equal(out.merged, 2);
    const open = (await pool.query(`SELECT canonical_id, reason, evidence FROM site.user_marks WHERE canonical_id = 'g1rsurv' AND cleared_at IS NULL`)).rows;
    assert.equal(open.length, 1, 'the survivor does not carry the restriction');
    assert.equal(open[0].reason, 'earliest', 'the earliest open mark must be the one kept');
    assert.deepEqual(open[0].evidence.map(Number), [1, 2, 3], 'evidence was lost in the merge');
    const closed = (await pool.query(`SELECT clear_note FROM site.user_marks WHERE reason = 'later'`)).rows[0];
    assert.equal(closed.clear_note, 'merged into g1rsurv');
    await pool.query(`DELETE FROM site.user_marks WHERE reason IN ('earliest', 'later')`);
  });

  await t.test('a merge keeps a carried mark over an EARLIER automatic one, so the evidence sweep cannot take the restriction with it', async () => {
    // automod.js's daily job deletes open source='automod' marks whose evidence is gone. Had the
    // merge kept the earlier automatic mark and closed the carried one into it, that sweep would
    // remove the only open mark — a restriction cleared by a clean-up.
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1rsur2', 's2'), ('g1rvic3', 'v3')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'g1r-s2', 'g1rsur2'), ('kick', 'g1r-v3', 'g1rvic3')`);
    await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ('g1rsur2', 's2', 100)`);
    await pool.query(`INSERT INTO site.user_marks (canonical_id, platform, platform_user, reason, source, evidence, created_by, created_at) VALUES
      ('g1rsur2', 'twitch', 'g1r-s2', 'automatic, older', 'automod', '{7,8,9}', 'automod', NOW() - interval '3 days'),
      ('g1rvic3', 'kick', 'g1r-v3', 'carried from a deleted account under a ban', 'carried', '{}', 'system', NOW() - interval '1 day')`);
    const out = await quiet(() => identity.mergeCanonicals(['g1rsur2', 'g1rvic3']));
    assert.equal(out.merged, 1);
    const open = (await pool.query(`SELECT source, reason, evidence FROM site.user_marks WHERE canonical_id = 'g1rsur2' AND cleared_at IS NULL`)).rows;
    assert.deepEqual(open.map((m) => [m.source, m.reason]), [['carried', 'carried from a deleted account under a ban']],
      'the automatic mark was kept and the carried one closed into it');
    assert.deepEqual(open[0].evidence.map(Number), [7, 8, 9], 'the automatic mark\'s evidence was not carried over');
    await pool.query(`DELETE FROM site.user_marks WHERE reason IN ('automatic, older', 'carried from a deleted account under a ban') AND canonical_id IN ('g1rsur2', 'g1rvic3')`);
  });

  await t.test('a later case record never weakens a ban or changes whose it is', async () => {
    // The upsert account-erase.js runs, used here — not a copy of its text.
    const { RESTRICTION_UPSERT_SQL } = require('./account-erase');
    await pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], ['g1r-banned'], '@g1r-later:site.test', 'case', null]);
    const row = (await pool.query(`SELECT matrix_id, reason, expires_at FROM stream.erased_restrictions WHERE platform_id = 'g1r-banned'`)).rows[0];
    assert.deepEqual(row, { matrix_id: '@g1r-gone:site.test', reason: 'ban', expires_at: null });
  });

  // ── a timeout's restriction ENDS (v156 expires_at) ──────────────────────────────────────────
  const { RESTRICTION_UPSERT_SQL } = require('./account-erase');
  const restrict = (pid, reason, expiresAt) => pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], [pid], '@g1r-gone3:site.test', reason, expiresAt]);
  const expiresOf = async (pid) => (await pool.query(`SELECT reason, expires_at FROM stream.erased_restrictions WHERE platform_id = $1`, [pid])).rows[0];

  await t.test('an EXPIRED timeout restriction no longer marks, blocks a merge, or survives as a ban', async () => {
    await restrict('g1r-timed', 'ban', new Date(Date.now() - 60_000).toISOString());
    const id = await quiet(() => identity.resolveOrCreate('twitch', 'g1r-timed', 'timedperson'));
    const mark = (await pool.query(`SELECT 1 FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [id])).rowCount;
    assert.equal(mark, 0, 'an ended timeout still marked the platform id\'s next identity');
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('g1rnew3', 'newperson3')`);
    const out = await quiet(() => identity.mergeCanonicals(['g1rnew3', id]));
    assert.equal(out.merged, 1, 'an ended timeout still kept the identity out of a merge');
  });

  await t.test('an UNEXPIRED timeout restriction still marks the next identity', async () => {
    await restrict('g1r-timing', 'ban', new Date(Date.now() + 600_000).toISOString());
    const id = await quiet(() => identity.resolveOrCreate('twitch', 'g1r-timing', 'timingperson'));
    assert.equal((await pool.query(`SELECT 1 FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [id])).rowCount, 1);
  });

  await t.test('the upsert never shortens a restriction, and an ended one is replaced whole', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await restrict('g1r-up', 'ban', soon);
    await restrict('g1r-up', 'ban', later);
    assert.equal(new Date((await expiresOf('g1r-up')).expires_at).toISOString(), later, 'a longer timeout did not extend it');
    await restrict('g1r-up', 'ban', soon);
    assert.equal(new Date((await expiresOf('g1r-up')).expires_at).toISOString(), later, 'a shorter timeout shortened it');
    await restrict('g1r-up', 'case', null);
    assert.deepEqual(await expiresOf('g1r-up'), { reason: 'ban', expires_at: null }, 'an open case must make it permanent');
    await restrict('g1r-old', 'ban', new Date(Date.now() - 1000).toISOString());
    await restrict('g1r-old', 'case', null);
    assert.deepEqual(await expiresOf('g1r-old'), { reason: 'case', expires_at: null }, 'an ENDED ban outranked a new case');
  });

  await t.test('every reader of erased_restrictions matches only unexpired rows (source scan)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.join(__dirname, 'identity.js'), 'utf8');
    const reads = [...src.matchAll(/(?:FROM|JOIN) stream\.erased_restrictions[^`']*/g)].map((m) => m[0]);
    assert.ok(reads.length >= 3, `only ${reads.length} reads found — the scan would be vacuous`);
    for (const r of reads) assert.match(r.replace(/\s+/g, ' '), /expires_at IS NULL OR \w*\.?expires_at > NOW\(\)/, `an unfiltered read: ${r}`);
    assert.match(src, /module\.exports/, 'vacuity: identity.js was read to its exports');
  });
});

// A3-06: a deleted account's restriction ends like a live account's — with the ban's lift, or with
// its case (the held-message retention, ADR 0104) — and the daily prune deletes ended rows. It used
// to have no end at all: "Already linked" forever, and a carried mark on every new identity.
test('an unban ends a deleted account\'s ban restriction; a case restriction ends with its case', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const GONE = '@g6r-gone:site.test';
  const MOD = '@g6r-mod:site.test';
  const clean = () => serially(pool, async () => {
    const minted = (await pool.query(`SELECT canonical FROM stream.links WHERE platform_id LIKE 'g6r-%'`)).rows.map((r) => r.canonical);
    await pool.query(`DELETE FROM site.user_marks WHERE platform_user LIKE 'g6r-%' OR canonical_id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'g6r-%'`);
    await pool.query(`DELETE FROM stream.links WHERE platform_id LIKE 'g6r-%'`);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [minted]);
    await pool.query(`DELETE FROM site.community_unbans WHERE matrix_id = $1`, [GONE]);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id = $1`, [GONE]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [[GONE, MOD]]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const { RESTRICTION_UPSERT_SQL, restrictionEnd } = require('./account-erase');
  const { createAutomod, AUTOMOD_HELD_RETENTION_DAYS } = require('./automod');
  const expiresOf = async (pid) => (await pool.query(`SELECT reason, expires_at FROM stream.erased_restrictions WHERE platform_id = $1`, [pid])).rows[0];
  const marked = async (pid) => {
    const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
    const id = await quiet(() => identity.resolveOrCreate('twitch', pid, `p-${pid}`));
    return (await pool.query(`SELECT 1 FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [id])).rowCount > 0;
  };

  await t.test('the lift of a deleted account\'s ban (web LIFT_BAN_SQL) ends its ban restriction', async () => {
    for (const m of [GONE, MOD]) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
    await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, NULL)`, [GONE, MOD]);
    await pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], ['g6r-banned'], GONE, 'ban', null]);
    const { LIFT_BAN_SQL } = await import('../web/app/lib/community/unbans.ts');
    await pool.query(LIFT_BAN_SQL, [GONE, MOD, crypto.randomUUID()]);
    const row = await expiresOf('g6r-banned');
    assert.ok(row.expires_at && new Date(row.expires_at).getTime() <= Date.now(), `the ban restriction outlived the unban: ${JSON.stringify(row)}`);
    assert.equal(await marked('g6r-banned'), false, 'the platform id\'s next identity was still marked after the unban');
    // A retry of the lift changes nothing, and never revives it.
    await pool.query(LIFT_BAN_SQL, [GONE, MOD, crypto.randomUUID()]);
    assert.ok(new Date((await expiresOf('g6r-banned')).expires_at).getTime() <= Date.now());
  });

  await t.test('a case restriction ends with the held-message retention; a ban with no end stays permanent', () => {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    const caseEnd = new Date(now + AUTOMOD_HELD_RETENTION_DAYS * 86_400_000).toISOString();
    assert.equal(restrictionEnd({ keepLinks: false, restrictionExpiresAt: null }, now), caseEnd, 'a case restriction has no end');
    assert.equal(restrictionEnd({ keepLinks: false, restrictionExpiresAt: '2026-11-01T00:00:00.000Z' }, now), '2026-11-01T00:00:00.000Z', 'web\'s end was not used');
    assert.equal(restrictionEnd({ keepLinks: true, restrictionExpiresAt: null }, now), null, 'a permanent ban got an end');
    assert.equal(restrictionEnd({ keepLinks: true, restrictionExpiresAt: '2026-10-26T00:00:00.000Z' }, now), '2026-10-26T00:00:00.000Z');
  });

  await t.test('the daily prune deletes ended restrictions and keeps running ones (and a second run deletes nothing)', async () => {
    await pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], ['g6r-case'], GONE, 'case', new Date(Date.now() - 1000).toISOString()]);
    await pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], ['g6r-open'], GONE, 'case', new Date(Date.now() + 86_400_000).toISOString()]);
    await pool.query(RESTRICTION_UPSERT_SQL, [['twitch'], ['g6r-perm'], GONE, 'ban', null]);
    const am = createAutomod({ pool, ai: {}, config: { get: () => null }, log: { log() {}, warn() {} } });
    const first = await am.dailyPrune();
    assert.ok(first.restrictions >= 2, `pruned ${first.restrictions} ended restrictions`);
    assert.equal(await expiresOf('g6r-case'), undefined, 'an ended case restriction was kept');
    assert.equal(await expiresOf('g6r-banned'), undefined, 'a lifted ban restriction was kept');
    assert.equal((await expiresOf('g6r-open')).reason, 'case', 'a running case restriction was pruned');
    assert.deepEqual(await expiresOf('g6r-perm'), { reason: 'ban', expires_at: null }, 'a permanent ban restriction was pruned');
    const second = await am.dailyPrune();
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.erased_restrictions WHERE platform_id LIKE 'g6r-%'`)).rows[0].n, 2);
    assert.equal(typeof second.restrictions, 'number');
  });
});

// Round 1 (reviewer): rows written before c73b02e4 for a deleted TIMEOUT with an open case read
// reason 'ban', expires_at NULL — permanent by mistake. migrations/migrate-v170.sql gives them the
// end the current rule writes, from what the rows hold; a real permanent ban keeps none.
test('an old NULL row after the migration (v170): a deleted timeout\'s restriction ends; a permanent ban\'s does not', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'migrate-v170.sql'), 'utf8');
  const pool = new Pool({ connectionString: URL });
  const [TO, PERM, LIFTED, MOD] = ['@g7r-to:site.test', '@g7r-perm:site.test', '@g7r-lifted:site.test', '@g7r-mod:site.test'];
  const people = [TO, PERM, LIFTED, MOD];
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform_id LIKE 'g7r-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [people]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  for (const m of people) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  // Deleted 2 days ago: a 1-hour timeout (long over), a permanent ban, a ban since lifted (no row).
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $3, now() - interval '2 days' + interval '1 hour'), ($2, $3, NULL)`, [TO, PERM, MOD]);
  for (const [pid, who] of [['g7r-to', TO], ['g7r-perm', PERM], ['g7r-lifted', LIFTED]]) {
    await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason, expires_at, created_at)
                      VALUES ('kick', $1, $2, 'ban', NULL, now() - interval '2 days')`, [pid, who]);
  }
  // Round 2: the same old rule wrote every CASE restriction with no end either.
  await pool.query(`INSERT INTO stream.erased_restrictions (platform, platform_id, matrix_id, reason, expires_at, created_at)
                    VALUES ('kick', 'g7r-case', $1, 'case', NULL, now() - interval '2 days')`, [LIFTED]);
  const row = async (pid) => (await pool.query(
    `SELECT expires_at, created_at FROM stream.erased_restrictions WHERE platform_id = $1`, [pid])).rows[0];
  const days = (r) => (new Date(r.expires_at).getTime() - new Date(r.created_at).getTime()) / 86_400_000;

  await pool.query(MIGRATION);
  const to = await row('g7r-to');
  assert.ok(to.expires_at, 'a deleted timeout\'s restriction is still endless');
  assert.ok(Math.abs(days(to) - 30) < 0.01, `the timeout's restriction should end with the case window, got ${days(to)} days`);
  assert.equal((await row('g7r-perm')).expires_at, null, 'a permanent ban\'s restriction was given an end');
  const lifted = await row('g7r-lifted');
  assert.ok(lifted.expires_at && Math.abs(days(lifted) - 30) < 0.01, 'a lifted ban\'s endless row was not given the case window');
  const caseRow = await row('g7r-case');
  assert.ok(caseRow.expires_at && Math.abs(days(caseRow) - 30) < 0.01, 'an old endless case restriction was not given the case window');

  // A retry of the migration changes nothing.
  const before = (await pool.query(`SELECT platform_id, expires_at FROM stream.erased_restrictions WHERE platform_id LIKE 'g7r-%' ORDER BY 1`)).rows;
  await pool.query(MIGRATION);
  const after = (await pool.query(`SELECT platform_id, expires_at FROM stream.erased_restrictions WHERE platform_id LIKE 'g7r-%' ORDER BY 1`)).rows;
  assert.deepEqual(after, before, 'a second run of v170 changed a row');
});
