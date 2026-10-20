// A person's name (names.js) against a REAL Postgres — the rule is one UPDATE …
// FROM over four tables, and a mock pool cannot tell a legal statement from an
// illegal one.
//
// A person's name is their SITE name if they have a site account, otherwise the
// name they chat under most — never a donation's typed name, which a donor can
// set to anything and which the bot would then use in lookups.
//
// Fixture ids are `nm…` / usernames `nm_…`, removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test names.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { refreshNames } = require('./names');
const { NATIVE_PLATFORM } = require('./native-platform');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';

async function clean(pool) {
  await pool.query(`DELETE FROM stream.chat_log WHERE user_id LIKE 'nm%'`);
  await pool.query(`DELETE FROM stream.links WHERE canonical LIKE 'nm%'`);
  await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@nm\\_%'`);
  await pool.query(`DELETE FROM stream.users WHERE id LIKE 'nm%'`);
}

async function person(pool, id, name) {
  await pool.query(`INSERT INTO stream.users (id, name, first_seen, last_seen) VALUES ($1,$2,NOW(),NOW())`, [id, name]);
}
async function says(pool, id, platform, username, n, ago = '1 hour') {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO stream.chat_log (user_id, platform, username, message, is_bot, created_at)
       VALUES ($1,$2,$3,'hi',false, NOW() - $4::interval)`,
      [id, platform, username, ago]
    );
  }
}
async function siteAccount(pool, id, matrixId, displayName) {
  await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1,$2)`, [matrixId, displayName]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('${NATIVE_PLATFORM}',$1,$2)`, [matrixId, id]);
}
const nameOf = async (pool, id) => (await pool.query('SELECT name FROM stream.users WHERE id=$1', [id])).rows[0].name;

test('a person gets their site name, else the name they chat under most — never a stale or typed one', { skip: !URL && 'SQL_PARSE_DATABASE_URL not set' }, async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await clean(pool);

    // Bram: site account, record renamed by a donation's typed name.
    await person(pool, 'nmbram000001', 'nm_Vadimir Putin');
    await siteAccount(pool, 'nmbram000001', '@nm_bram:site.test', 'nm_Bram');
    await says(pool, 'nmbram000001', 'twitch', 'nm_bram_tw', 30);

    // Twitch-only chatter whose record carries an old handle.
    await person(pool, 'nmtwitch0001', 'nm_oldhandle');
    await says(pool, 'nmtwitch0001', 'twitch', 'nm_newhandle', 5);
    await says(pool, 'nmtwitch0001', 'youtube', 'nm_ythandle', 2);

    // A tie between two names: the more recently used one wins.
    await person(pool, 'nmtie0000001', 'nm_x');
    await says(pool, 'nmtie0000001', 'twitch', 'nm_older', 3, '3 days');
    await says(pool, 'nmtie0000001', 'kick', 'nm_newer', 3, '1 hour');

    // A blank site display name falls through to the chat name.
    await person(pool, 'nmblank00001', 'nm_whatever');
    await siteAccount(pool, 'nmblank00001', '@nm_blank:site.test', '   ');
    await says(pool, 'nmblank00001', NATIVE_PLATFORM, 'nm_blankchat', 2);

    // Someone who has not chatted recently and has no site account is left alone.
    await person(pool, 'nmquiet00001', 'nm_quiet');
    await says(pool, 'nmquiet00001', 'twitch', 'nm_ancient', 4, '60 days');

    const changed = await refreshNames(pool);

    assert.equal(await nameOf(pool, 'nmbram000001'), 'nm_Bram', 'site name wins over chat names and the typed donation name');
    assert.equal(await nameOf(pool, 'nmtwitch0001'), 'nm_newhandle', 'most-used recent chat name');
    assert.equal(await nameOf(pool, 'nmtie0000001'), 'nm_newer', 'tie → most recent');
    assert.equal(await nameOf(pool, 'nmblank00001'), 'nm_blankchat', 'blank site name is not a name');
    assert.equal(await nameOf(pool, 'nmquiet00001'), 'nm_quiet', 'no recent chat, no site account → untouched');
    assert.ok(changed >= 4, `expected at least the four fixture renames, got ${changed}`);

    // Idempotent: a second pass changes nothing among the fixtures.
    await refreshNames(pool);
    assert.equal(await nameOf(pool, 'nmbram000001'), 'nm_Bram');
  } finally {
    await clean(pool).catch(() => {});
    await pool.end();
  }
});
