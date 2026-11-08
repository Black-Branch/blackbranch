// A held line follows its sender through a merge, against a REAL Postgres (reviewer round 1 on
// c73b02e4). A mod's identity merge (mergeCanonicals) deletes the losing canonical; a held row
// (site.automod_held.user_id) still naming it made Allow answer "the sender deleted their account"
// and drop the line. The merge now repoints our own held rows to the survivor, so the release posts
// under the person it merged into (chat.js: a release names the row's canonical).
// Fixtures are scoped to ids beginning `mh0` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=… node --test identity-merge-held.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; return Promise.resolve().then(fn).finally(() => { console.warn = w; console.log = l; }); };

test('a held line follows its sender through a merge', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const ids = ['mh0000000001', 'mh0000000002'];
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.automod_held WHERE text LIKE 'mh0 %'`);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1) OR platform_id LIKE 'mh0-%'`, [ids]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [ids]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  for (const id of ids) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('kick', 'mh0-k', $1), ('twitch', 'mh0-t', $2)`, ids);
  // The survivor is the one with more chat; the held line is the OTHER identity's.
  for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, 'kick', 'x', 'hi')`, [ids[0]]);
  await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ($1, 'x', 50), ($2, 'x', 0)`, ids); // the busier one is SAID, never left to a first_seen tie
  const held = Number((await pool.query(
    `INSERT INTO site.automod_held (source, platform, user_id, user_name, text, status) VALUES ('account_age', 'twitch', $1, 'x', 'mh0 held line', 'pending') RETURNING id`,
    [ids[1]])).rows[0].id);
  // A Twitch AutoMod row's user_id is a TWITCH id, never repointed (it is not a canonical).
  const twitchRow = Number((await pool.query(
    `INSERT INTO site.automod_held (source, user_id, user_name, text, status, twitch_msg_id) VALUES ('twitch', $1, 'x', 'mh0 twitch row', 'pending', 'mh0-msg') RETURNING id`,
    [ids[1]])).rows[0].id);

  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const out = await quiet(() => identity.mergeCanonicals(ids));
  assert.equal(out.survivor, ids[0], 'precondition: the busier identity survives');
  const userOf = async (id) => (await pool.query(`SELECT user_id FROM site.automod_held WHERE id = $1`, [id])).rows[0].user_id;
  assert.equal(await userOf(held), ids[0], 'the held row still names the deleted (merged) canonical');
  assert.equal(await userOf(twitchRow), ids[1], 'a Twitch row\'s Twitch id was rewritten');
  // A retry of the merge changes nothing.
  await quiet(() => identity.mergeCanonicals(ids));
  assert.equal(await userOf(held), ids[0]);
});

// Push review on fecab52b: a platform-only ban lives in site.mod_log on the canonical it was about
// (target_id), and that row must keep saying who it was about — it is not moved. So a BANNED loser's
// pending held lines (its standing, config/canonical-standing.mjs, has a row) are not carried to the
// survivor, where an Allow after a later unban would post them: they are closed as denied by the
// merge, in its transaction.
test('a banned loser merged into a clean survivor: its held line can no longer be allowed', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const ids = ['ab1000000001', 'ab1000000002', 'ab1000000003'];   // survivor, banned loser, unbanned loser (12-hex, as real canonicals are)
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.automod_held WHERE text LIKE 'mh1 %'`);
    await pool.query(`DELETE FROM site.mod_log WHERE target_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1) OR platform_id LIKE 'mh1-%'`, [ids]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [ids]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  for (const id of ids) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, 'kick', 'x', 'hi')`, [ids[0]]);
  for (const [n, id] of ids.entries()) await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ($1, 'x', $2)`, [id, n === 0 ? 50 : 0]); // the busier one is SAID, never left to a first_seen tie
  const log = (target, action, agoMin) => pool.query(
    `INSERT INTO site.mod_log (action, target_id, performed_by, created_at) VALUES ($1, $2, '@mod:site.test', now() - make_interval(mins => $3))`,
    [action, target, agoMin]);
  await log(ids[1], 'ban', 30);                       // banned, and still banned
  await log(ids[2], 'ban', 30); await log(ids[2], 'unban', 10);   // banned, then unbanned
  const hold = async (who, text) => Number((await pool.query(
    `INSERT INTO site.automod_held (source, platform, user_id, user_name, text, status) VALUES ('account_age', 'kick', $1, 'x', $2, 'pending') RETURNING id`,
    [who, text])).rows[0].id);
  const bannedLine = await hold(ids[1], 'mh1 banned line');
  const freeLine = await hold(ids[2], 'mh1 free line');

  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const out = await quiet(() => identity.mergeCanonicals(ids));
  assert.equal(out.survivor, ids[0], 'precondition: the busier identity survives');
  const rowOf = async (id) => (await pool.query(`SELECT user_id, status, resolved_by FROM site.automod_held WHERE id = $1`, [id])).rows[0];
  const banned = await rowOf(bannedLine);
  assert.equal(banned.status, 'denied', 'a banned loser\'s held line is still pending — an Allow would post it under the clean survivor');
  assert.equal(banned.resolved_by, 'system');
  assert.deepEqual(await rowOf(freeLine), { user_id: ids[0], status: 'pending', resolved_by: null }, 'an unbanned loser\'s line did not follow the person');
  // The ban row still says who it was about.
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.mod_log WHERE target_id = $1 AND action = 'ban'`, [ids[1]])).rows[0].n, 1);
});

// Re-gate round 2: a platform-only BAN lives in mod_log on the canonical it was about. Merged away,
// that canonical is gone and its ban with it — a line held LATER as the survivor passed Allow's
// bannedNow check (web platformRetry.ts) and the 15-minute chat hold (keyed on the loser). The merge
// now carries the loser's standing ban or running timeout to the survivor as a NEW mod_log row
// ("carried by merge from <loser>"); the original row stays. It never weakens a stronger standing
// the survivor already has, and an unban (no standing) carries nothing. The whole standing rule —
// linking, site unbans, timeouts, carries over an older unban — runs through both readers in
// ban-standing.db.test.js.
test('a platform-only ban carries through a merge: a line held later as the survivor is refused', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const { bannedNow } = await import('../web/app/lib/platformRetry.ts');
  const pool = new Pool({ connectionString: URL });
  const q = (sql, p) => pool.query(sql, p);
  // Three merges: [survivor, loser] each. a: banned loser; b: banned-then-unbanned loser;
  // c: survivor permanently banned, loser on a running timeout (no downgrade).
  const pairs = { a: ['ab2a00000001', 'ab2a00000002'], b: ['ab2b00000001', 'ab2b00000002'], c: ['ab2c00000001', 'ab2c00000002'] };   // 12-hex, as real canonicals are
  const all = Object.values(pairs).flat();
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.mod_log WHERE target_id = ANY($1)`, [all]);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [all]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [all]);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [all]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [all]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  for (const id of all) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [id]);
  // The survivor is chosen by stream.user_stats.activity (tiebreak: oldest first_seen) — identity.js
  // mergeCanonicals. Chat rows alone decide nothing here (the aggregate is not rebuilt in a test), and two
  // users inserted in the same second tie on first_seen, so the busier one is SAID: activity 50 vs 0.
  for (const [s, l] of Object.values(pairs)) {
    for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, 'kick', 'x', 'hi')`, [s]);
    await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ($1, 'x', 50), ($2, 'x', 0)`, [s, l]);
  }
  const log = (target, action, agoMin, expiresInMin = null) => pool.query(
    `INSERT INTO site.mod_log (action, target_id, performed_by, expires_at, created_at)
     VALUES ($1, $2, '@mod:site.test', CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END,
             now() - make_interval(mins => $4::int))`, [action, target, expiresInMin, agoMin]);
  await log(pairs.a[1], 'ban', 30);
  await log(pairs.b[1], 'ban', 30); await log(pairs.b[1], 'unban', 10);
  await log(pairs.c[0], 'ban', 40); await log(pairs.c[1], 'timeout', 20, 60);

  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  for (const p of Object.values(pairs)) {
    const out = await quiet(() => identity.mergeCanonicals(p));
    assert.equal(out.survivor, p[0], 'precondition: the busier identity survives');
  }
  // a: the survivor is banned now — a line held as it is refused; the carried row says from whom,
  // and the loser's own row stays.
  assert.equal(await bannedNow(pairs.a[0], q), true, 'a banned loser\'s ban was lost in the merge');
  const carried = (await pool.query(`SELECT action, performed_by, reason FROM site.mod_log WHERE target_id = $1`, [pairs.a[0]])).rows;
  assert.deepEqual(carried, [{ action: 'ban', performed_by: 'system', reason: `carried by merge from ${pairs.a[1]}` }]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.mod_log WHERE target_id = $1`, [pairs.a[1]])).rows[0].n, 1, 'the original ban row moved');
  // b: unbanned before the merge — nothing carried, a line held as the survivor posts.
  assert.equal(await bannedNow(pairs.b[0], q), false, 'an unbanned loser\'s old ban was carried');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.mod_log WHERE target_id = $1`, [pairs.b[0]])).rows[0].n, 0);
  // c: the survivor's permanent ban is not weakened by the loser's carried timeout (a timeout never
  // weakens a ban — the standing rule).
  assert.equal(await bannedNow(pairs.c[0], q), true, 'a carried timeout weakened the survivor\'s permanent ban');
  // A retry of the merges carries nothing twice.
  for (const p of Object.values(pairs)) await quiet(() => identity.mergeCanonicals(p));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.mod_log WHERE target_id = $1`, [pairs.a[0]])).rows[0].n, 1);
});
