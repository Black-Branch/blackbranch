// /user/lookup asked FOR ONE PLATFORM (`platform=…`) — what the !rank / !karma chat command asks —
// against a REAL Postgres. Looking a name up across the whole merged identity and answering with
// the identity's preferred name would publish a hidden link: on Twitch, `!rank gadget_tw` for a
// person whose site account "CaseySite" is linked with show_links off would say "@CaseySite — …"
// to everyone in that chat. So, unless every account on the
// identity shows its links (noOptOutSql), the answer is the ONE platform identity asked about: its
// handle on that platform and that identity's own figures, and a name from another platform (or the
// site) is not found at all.
// Fixtures are scoped to ids beginning `rktest` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test profiles-identity.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { NATIVE_PLATFORM } = require('./native-platform');
const { ERASED_CANONICAL } = require('./account-erase');
const { registerProfileRoutes } = require('./profiles');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';

test('/user/lookup per platform identity against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const me = '@rktest-casey:site.test';
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id LIKE 'rktest%' OR stream_id LIKE 'rktest%'`);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id LIKE 'rktest%'`);
    await pool.query(`DELETE FROM stream.links WHERE canonical LIKE 'rktest%'`);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id LIKE '@rktest%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@rktest%'`);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical LIKE 'rktest%'`);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'rktest%'`);
    await pool.query(`DELETE FROM stream.sessions WHERE stream_id LIKE 'rktest%'`);
    await pool.query(`DELETE FROM stream.users u WHERE u.id = $1
      AND NOT EXISTS (SELECT 1 FROM stream.chat_log WHERE user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM stream.support_events WHERE user_id = u.id)`, [ERASED_CANONICAL]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  // One person: a site account "CaseySite" linked to a Twitch handle and a YouTube handle, show_links OFF.
  await pool.query(`INSERT INTO stream.sessions (stream_id) VALUES ('rktest-s1'), ('rktest-s2'), ('rktest-s3')`);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ('rktestcanon', 'CaseySite'), ('rktestother', 'plainviewer')`);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, '(deleted)') ON CONFLICT (id) DO NOTHING`, [ERASED_CANONICAL]);
  await pool.query(`INSERT INTO stream.nameidx (name_lower, canonical) VALUES ('gadget_tw', 'rktestcanon'), ('gadget_yt', 'rktestcanon'), ('caseysite', 'rktestcanon'), ('plainviewer', 'rktestother')`);
  await pool.query(`INSERT INTO site.users (matrix_id, display_name, show_links) VALUES ($1, 'CaseySite', false)`, [me]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-rk', 'rktestcanon'), ($1, 'youtube', 'yt-rk', 'rktestcanon')`, [me]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('${NATIVE_PLATFORM}', $1, 'rktestcanon'), ('twitch', 'tw-rk', 'rktestcanon'), ('youtube', 'yt-rk', 'rktestcanon'), ('twitch', 'tw-rk-other', 'rktestother')`, [me]);
  // Twitch: 3 lines over 2 streams, a member. YouTube: 5 lines in 1 stream. Site: 2 lines.
  const line = (canon, platform, username, stream, n, extra = '') => pool.query(
    `INSERT INTO stream.chat_log (user_id, platform, username, message, stream_id, is_member, karma, created_at)
     SELECT $1, $2, $3, 'rktest words ' || g, $4, ${extra === 'member' ? 'true' : 'false'}, 0.8, NOW() - (g || ' minutes')::interval
       FROM generate_series(1, $5) g`, [canon, platform, username, stream, n]);
  await line('rktestcanon', 'twitch', 'gadget_tw', 'rktest-s1', 2, 'member');
  await line('rktestcanon', 'twitch', 'gadget_tw', 'rktest-s2', 1, 'member');
  await line('rktestcanon', 'youtube', 'gadget_yt', 'rktest-s3', 5);
  await line('rktestcanon', NATIVE_PLATFORM, 'CaseySite', 'rktest-s3', 2);
  await line('rktestother', 'twitch', 'plainviewer', 'rktest-s1', 4);
  // A deleted person's kept Twitch line (account-erase.js moves it onto the erased-person row).
  await line(ERASED_CANONICAL, 'twitch', 'rktest_gone', 'rktest-s1', 1);
  // The merged profile row the aggregate pass would write — the figures that must NOT leak.
  await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity, streams, support, support_tier, regularity_tier, word_count_tier, intelligence, intelligence_tier)
    VALUES ('rktestcanon', 'CaseySite', 10, 3, 25, 'Patron', 'Constant', 'Writer', 0.9, 'Smart'),
           ('rktestother', 'plainviewer', 4, 1, 0, 'None', 'Familiar', 'Reactor', NULL, NULL)`);

  const routes = {};
  registerProfileRoutes({ get: (p, ...h) => { routes[p] = h[h.length - 1]; } }, {
    pool, requireInternal: () => {}, wrap: (fn) => fn,
    // A scoring plugin's label: a merged figure, so it rides only the merged answer.
    profileExtras: async () => ({ temperamentLabel: 'Warm', labelRank: 4 }),
  });
  const lookup = async (query) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await routes['/user/lookup']({ query }, res);
    return { status: res.statusCode, body: res.body };
  };
  const setShowLinks = (on) => pool.query(`UPDATE site.users SET show_links = $2 WHERE matrix_id = $1`, [me, on]);

  await t.test('show_links off: the Twitch handle asked from Twitch is answered as itself, with only its own figures', async () => {
    const r = await lookup({ platform: 'twitch', username: 'gadget_tw' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'gadget_tw', 'the answer named the identity by another name — the link leaks');
    assert.equal(r.body.scope, 'identity');
    assert.deepEqual([r.body.activity, r.body.streams, r.body.isMember], [3, 2, true], 'not the Twitch identity\'s own figures');
    const text = JSON.stringify(r.body);
    for (const leak of ['CaseySite', 'rktestcanon', 'Patron', 'Constant', 'Writer', 'Smart', 'Warm']) {
      assert.ok(!text.includes(leak), `the per-identity answer carries "${leak}" — a merged/linked figure`);
    }
  });

  await t.test('the two handles\' answers differ (identical figures would publish the link too)', async () => {
    const tw = (await lookup({ platform: 'twitch', username: 'gadget_tw' })).body;
    const yt = (await lookup({ platform: 'youtube', username: '@Gadget_YT' })).body;
    assert.equal(yt.name, 'gadget_yt');
    assert.deepEqual([yt.activity, yt.streams, yt.isMember], [5, 1, false]);
    assert.notDeepEqual(tw, yt);
  });

  await t.test('a name from another platform or the site is not found from Twitch', async () => {
    assert.equal((await lookup({ platform: 'twitch', username: 'CaseySite' })).status, 404, 'a site display name confirmed the site account from Twitch');
    assert.equal((await lookup({ platform: 'twitch', username: 'gadget_yt' })).status, 404, 'a YouTube handle answered from Twitch');
  });

  await t.test('self (by canonical or platform user id) answers for the asker\'s identity on THAT platform', async () => {
    for (const q of [{ platform: 'twitch', canonicalId: 'rktestcanon', username: 'gadget_tw' }, { platform: 'twitch', userId: 'tw-rk', username: 'gadget_tw' }]) {
      const r = await lookup(q);
      assert.equal(r.status, 200, JSON.stringify(q));
      assert.equal(r.body.name, 'gadget_tw', `self ${JSON.stringify(q)} printed another name`);
      assert.equal(r.body.activity, 3);
    }
  });

  await t.test('a person with nothing linked is answered by their own handle', async () => {
    const r = await lookup({ platform: 'twitch', username: 'PlainViewer' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.name, r.body.activity, r.body.scope], ['plainviewer', 4, 'identity']);
  });

  await t.test('erased: no record, by name or id', async () => {
    assert.equal((await lookup({ platform: 'twitch', username: 'rktest_gone' })).status, 404);
    assert.equal((await lookup({ platform: 'twitch', canonicalId: ERASED_CANONICAL, username: 'rktest_gone' })).status, 404);
  });

  await t.test('two handles of one person on the SAME platform answer apart, each as itself', async () => {
    // A second Twitch account merged into the same identity (or an old name of the same account).
    // A site account holds one link per platform, so the second account is on stream.links only.
    try {
      await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', 'tw-rk-2', 'rktestcanon')`);
      await pool.query(`INSERT INTO stream.nameidx (name_lower, canonical) VALUES ('gizmo_tw', 'rktestcanon')`);
      await line('rktestcanon', 'twitch', 'Gizmo_TW', 'rktest-s3', 7);
      const a = (await lookup({ platform: 'twitch', username: 'gadget_tw' })).body;
      const b = (await lookup({ platform: 'twitch', username: 'gizmo_tw' })).body;
      assert.deepEqual([a.name, a.activity, a.streams], ['gadget_tw', 3, 2], 'the first handle carries the other handle\'s lines or name');
      assert.deepEqual([b.name, b.activity, b.streams], ['Gizmo_TW', 7, 1], 'the second handle carries the first one\'s lines or name');
      // Self by account id answers for the handle the asker is using, not the newest one.
      const self = (await lookup({ platform: 'twitch', userId: 'tw-rk', username: 'gadget_tw' })).body;
      assert.deepEqual([self.name, self.activity], ['gadget_tw', 3]);
    } finally {
      await pool.query(`DELETE FROM stream.chat_log WHERE user_id = 'rktestcanon' AND username = 'Gizmo_TW'`);
      await pool.query(`DELETE FROM stream.nameidx WHERE name_lower = 'gizmo_tw'`);
      await pool.query(`DELETE FROM stream.links WHERE platform_id = 'tw-rk-2'`);
    }
  });

  await t.test('a platform lookup without the handle is refused (it could only answer the whole platform)', async () => {
    assert.equal((await lookup({ platform: 'twitch', canonicalId: 'rktestcanon' })).status, 400);
    assert.equal((await lookup({ platform: 'twitch', userId: 'tw-rk' })).status, 400);
  });

  await t.test('a platform that is not a platform name is refused', async () => {
    for (const platform of ['', 'Twitch; DROP', 'x'.repeat(40), ['twitch', 'youtube']]) {
      assert.equal((await lookup({ platform, username: 'gadget_tw' })).status, 400, JSON.stringify(platform));
    }
  });

  await t.test('show_links on for every account: the merged answer with the preferred name, as before', async () => {
    await setShowLinks(true);
    try {
      const r = await lookup({ platform: 'twitch', username: 'gadget_tw' });
      assert.equal(r.status, 200);
      assert.equal(r.body.name, 'CaseySite');
      assert.equal(r.body.scope, 'merged');
      assert.deepEqual([r.body.activity, r.body.supportTier, r.body.temperamentLabel], [10, 'Patron', 'Warm']);
      // The site name is consented to, so it is found from Twitch.
      const bySite = await lookup({ platform: 'twitch', username: 'CaseySite' });
      assert.equal(bySite.status, 200);
      assert.equal(bySite.body.name, 'CaseySite');
    } finally {
      await setShowLinks(false);
    }
  });

  await t.test('a handle whose first owner is someone on another platform finds the person who uses it HERE', async () => {
    // A stranger on Twitch who goes by the same handle as Casey's YouTube one.
    await line('rktestother', 'twitch', 'gadget_yt', 'rktest-s2', 2);
    const r = await lookup({ platform: 'twitch', username: 'gadget_yt' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.name, r.body.activity], ['gadget_yt', 2], 'not the Twitch person who uses the handle, or not only that handle\'s lines');
    assert.ok(!JSON.stringify(r.body).includes('CaseySite'));
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = 'rktestother' AND username = 'gadget_yt'`);
  });

  await t.test('without a platform the lookup is the merged one (web\'s card path, unchanged)', async () => {
    const r = await lookup({ canonicalId: 'rktestcanon' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.name, r.body.activity, r.body.canonicalId], ['CaseySite', 10, 'rktestcanon']);
  });
});
