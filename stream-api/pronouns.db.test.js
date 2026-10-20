// A mod's `/pronouns @name` against a REAL Postgres:
// stream.nameidx keeps ONE row per name — whoever chatted under it first — so it
// can neither see a shared name nor find the newer holder. The lookup reads who
// actually chatted under the name in the last 30 days instead.
//
// Fixture ids are `pn…`, removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test pronouns.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createPronouns } = require('./pronouns');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';

async function clean(pool) {
  await pool.query(`DELETE FROM stream.chat_log WHERE user_id LIKE 'pn%'`);
  await pool.query(`DELETE FROM stream.nameidx WHERE canonical LIKE 'pn%'`);
  await pool.query(`DELETE FROM stream.users WHERE id LIKE 'pn%'`);
}
async function person(pool, id) {
  await pool.query(`INSERT INTO stream.users (id, name, first_seen, last_seen) VALUES ($1, $1, NOW(), NOW())`, [id]);
}
async function said(pool, id, username, daysAgo = 0) {
  await pool.query(
    `INSERT INTO stream.chat_log (user_id, platform, username, message, is_bot, created_at)
     VALUES ($1, 'twitch', $2, 'hi', FALSE, NOW() - make_interval(days => $3))`, [id, username, daysAgo]);
}

test('a mod names someone — against a real schema', { skip: !URL && 'SQL_PARSE_DATABASE_URL not set' }, async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await clean(pool);
    for (const id of ['pnfirst00001', 'pnalex000001', 'pnalex000002', 'pnsolo000001']) await person(pool, id);
    // The FIRST holder of "pnalex" owns the name index, but has not chatted in months.
    await pool.query(`INSERT INTO stream.nameidx (name_lower, canonical) VALUES ('pnalex', 'pnfirst00001'), ('pnsolo', 'pnfirst00001')`);
    await said(pool, 'pnfirst00001', 'pnalex', 90);
    const pronouns = createPronouns({ pool });
    const routes = {};
    pronouns.registerPronounRoutes({ post: (p, ...h) => { routes[p] = h.at(-1); } }, { requireInternal: (q, s, n) => n(), wrap: (fn) => fn });
    const call = async (body) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await routes['/identity/pronoun-command']({ body }, res);
      return res.body;
    };
    const pron = async (id) => (await pool.query(`SELECT pronouns, pronouns_source FROM stream.users WHERE id = $1`, [id])).rows[0];

    // One person chatted as PnSolo this month: they get it, not the name index's owner.
    await said(pool, 'pnsolo000001', 'PnSolo', 2);
    assert.deepEqual(await call({ text: '!pronouns she', name: '@pnsolo', source: 'mod' }), { matched: true, pronouns: 'she/her', canonicalId: 'pnsolo000001' });
    assert.deepEqual(await pron('pnsolo000001'), { pronouns: 'she/her', pronouns_source: 'mod' });
    assert.equal((await pron('pnfirst00001')).pronouns, null, 'the first-ever holder of the name is untouched');

    // Two people chatted as pnalex this month: refused, nothing written.
    await said(pool, 'pnalex000001', 'pnalex', 1);
    await said(pool, 'pnalex000002', 'PNALEX', 3);
    assert.deepEqual(await call({ text: '!pronouns he', name: 'pnalex', source: 'mod' }), { matched: true, ambiguous: true });
    for (const id of ['pnalex000001', 'pnalex000002', 'pnfirst00001']) assert.equal((await pron(id)).pronouns, null);

    // Nobody this month.
    assert.deepEqual(await call({ text: '!pronouns he', name: 'pnnobody', source: 'mod' }), { matched: true, notFound: true });
  } finally {
    await clean(pool).catch(() => {});
    await pool.end();
  }
});
