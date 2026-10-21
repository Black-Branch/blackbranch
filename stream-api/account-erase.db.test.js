// The stream-side half of "Delete my account" (account-erase.js) against a REAL Postgres: their
// linked platform lines tombstoned (rows kept), quotes of them in other people's replies removed,
// their name stripped from support events (the amount kept), the site link removed, AI memory
// forgotten, the live buffer purged — and nobody else's rows touched. The stream-side PROFILE goes
// too: stream.users, user_stats, nameidx and every platform link of a canonical
// that was this account's alone are deleted, the kept lines and payments are moved onto the one
// erased-person row, and /user/lookup answers 404 — even after an aggregate rebuild.
// Fixtures are scoped to ids beginning `aetest` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=postgres://postgres:probe@localhost:55432/stream node --test account-erase.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createMemory } = require('./memory');
const { NATIVE_PLATFORM, NATIVE_SQL } = require('./native-platform');
const { createAccountErase, ERASED_CANONICAL } = require('./account-erase');
const { registerProfileRoutes } = require('./profiles');
const { createAggregates } = require('./aggregates');
const { createIdentity } = require('./identity');
const { serially } = require('./testlib/db-serial.js');
// The install's site plugin, through the seam index.js uses (absent in the public build).
const owner = require('./plugins').loadOwnerPlugin();

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const quiet = { log() {}, warn() {}, error() {} };

test('stream-side account erase against real Postgres', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const pool = new Pool({ connectionString: URL });
  const me = '@aetest-me:x';
  // The fixture's platform ids. A fresh identity minted for one after the erase has a random id, so
  // it is found (and removed) through these.
  const PLATFORM_IDS = ['tw-ae', 'tw-other', 'tw-ban'];
  const clean = () => serially(pool, async () => {
    const fresh = (await pool.query(`SELECT canonical FROM stream.links WHERE platform = 'twitch' AND platform_id = ANY($1) AND canonical NOT LIKE 'aetest%'`, [PLATFORM_IDS])).rows.map((r) => r.canonical);
    if (fresh.length) {
      await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [fresh]);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = ANY($1)`, [fresh]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [fresh]);
      await pool.query(`DELETE FROM stream.user_stats WHERE user_id = ANY($1)`, [fresh]);
      await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [fresh]);
    }
    await pool.query(`DELETE FROM stream.memory_opt_out_platform_ids WHERE platform = 'twitch' AND platform_id = ANY($1)`, [PLATFORM_IDS]);
    await pool.query(`DELETE FROM site.memory_opt_outs WHERE matrix_id LIKE '@aetest%'`);
    await pool.query(`DELETE FROM site.mod_log WHERE target_id LIKE '@aetest%'`);
    await pool.query(`DELETE FROM stream.message_embeddings WHERE message LIKE 'aetest%'`);
    await pool.query(`DELETE FROM site.chat_messages WHERE matrix_id LIKE '@aetest%'`);
    await pool.query(`DELETE FROM stream.support_events WHERE user_id LIKE 'aetest%' OR event_id LIKE 'aetest%'`);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id LIKE 'aetest%' OR platform_msg_id LIKE 'aetest%'`);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id LIKE 'aetest%'`);
    await pool.query(`DELETE FROM stream.links WHERE canonical LIKE 'aetest%'`);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id LIKE '@aetest%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@aetest%'`);
    await pool.query(`DELETE FROM stream.bot_memory WHERE body LIKE '%aetest-lore%'`);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical LIKE 'aetest%'`);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'aetest%'`);
    // The erased-person row is shared by every erase; remove it only when nothing points at it.
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id = $1`, [ERASED_CANONICAL]);
    await pool.query(`DELETE FROM stream.users u WHERE u.id = $1
      AND NOT EXISTS (SELECT 1 FROM stream.chat_log WHERE user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM stream.support_events WHERE user_id = u.id)`, [ERASED_CANONICAL]);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO stream.users (id, name) VALUES ('aetestcanon', 'meontwitch'), ('aetestother', 'someoneelse')`);
  await pool.query(`INSERT INTO stream.nameidx (name_lower, canonical) VALUES ('meontwitch', 'aetestcanon')`);
  // A plugin's SHARED note naming the person and someone else: a self-deletion never removes it.
  await pool.query(`INSERT INTO stream.bot_memory (kind, slot, body) VALUES ('lore', 'aetest', 'meontwitch and someoneelse run the aetest-lore bit')`);
  await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Me')`, [me]);
  // They had switched AI memory off.
  await pool.query(`INSERT INTO site.memory_opt_outs (matrix_id) VALUES ($1)`, [me]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-ae', 'aetestcanon')`, [me]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('${NATIVE_PLATFORM}', $1, 'aetestcanon'), ('twitch', 'tw-ae', 'aetestcanon'), ('twitch', 'tw-other', 'aetestother')`, [me]);
  await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity, support) VALUES ('aetestcanon', 'meontwitch', 1, 4.99)`);
  const myLine = (await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, emotes, platform_msg_id) VALUES ('aetestcanon', 'twitch', 'meontwitch', 'my twitch words', '{"a":1}', 'aetest-mine') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, reply_to_id, reply_to_username, reply_to_text) VALUES ('aetestother', 'twitch', 'someoneelse', 'answering', $1, 'meontwitch', 'my twitch words')`, [myLine]);
  await pool.query(`INSERT INTO stream.support_events (user_id, platform, username, amount_usd, event_type, event_id) VALUES ('aetestcanon', 'twitch', 'meontwitch', 4.99, 'sub', 'aetest-se-mine'), ('aetestother', 'twitch', 'someoneelse', 1, 'bits', 'aetest-se-other')`);

  const memory = createMemory({ pool, log: quiet, config: { get: () => null, snapshot: () => ({ state: { loaded: true } }) } });
  // The site plugin's REAL forget handler, registered exactly as index.js does (its bot data
  // surface registers it on memory) — without it the lore assertion below would pass over nothing.
  // No plugin (the public build): no handler, and nothing else writes that table.
  const noRoutes = { get() {}, post() {}, put() {}, delete() {} };
  owner?.botRoutes?.data?.(noRoutes, { pool, memory, liveState: async () => ({ live: false }), resolveCanonical: async () => null, pronounsFor: async () => null, personLocalTime: () => null, requireInternal: () => {}, wrap: (fn) => fn });
  const buffer = [
    { type: 'message', platform: 'twitch', id: myLine, canonicalId: 'aetestcanon', message: 'my twitch words' },
    { type: 'message', platform: NATIVE_PLATFORM, id: 77, matrixId: me, message: 'site words' },
    { type: 'message', platform: 'twitch', id: 78, canonicalId: 'aetestother', message: 'theirs' },
  ];
  const frames = [];
  const redacted = [];
  // The REAL identity module (its cache must forget the person too) and a sponsor pool that records the hook.
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });
  const sponsorErased = [];
  const sponsors = { erase: (x) => sponsorErased.push(x) };
  // Their platform id is resolved once before the erase, so the identity cache holds it.
  assert.equal(await identity.resolveOrCreate('twitch', 'tw-ae', 'meontwitch'), 'aetestcanon');
  const ae = createAccountErase({ pool, memory, identity, sponsors, log: quiet, msgBuffer: buffer, broadcast: (f) => frames.push(f), redactBuffered: (b) => redacted.push(b.id) });

  const out = await ae.erase(me);
  const line = (await pool.query(`SELECT message, emotes, is_deleted FROM stream.chat_log WHERE id = $1`, [myLine])).rows[0];
  assert.deepEqual([line.message, line.emotes, line.is_deleted], ['', null, true], 'their platform line kept its text');
  const reply = (await pool.query(`SELECT message, reply_to_text, reply_to_username FROM stream.chat_log WHERE user_id = 'aetestother'`)).rows[0];
  assert.deepEqual([reply.message, reply.reply_to_text, reply.reply_to_username], ['answering', null, '(deleted)'], 'a quote of them (or their name) survived in another person\'s reply, or the reply lost its own text');
  const se = (await pool.query(`SELECT event_id, user_id, username, amount_usd::float AS amount FROM stream.support_events WHERE event_id LIKE 'aetest%' ORDER BY event_id`)).rows;
  assert.deepEqual(se, [
    { event_id: 'aetest-se-mine', user_id: ERASED_CANONICAL, username: '(deleted)', amount: 4.99 },
    { event_id: 'aetest-se-other', user_id: 'aetestother', username: 'someoneelse', amount: 1 },
  ], 'the payment record was lost, or still points at the person');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.links WHERE platform IN ${NATIVE_SQL} AND platform_id = $1`, [me])).rows[0].n, 0);
  assert.deepEqual(redacted.sort(), [77, myLine].sort(), 'the live buffer kept their lines, or lost someone else\'s');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'purge');
  assert.deepEqual(frames[0].ids.map((x) => x.id).sort(), [77, myLine].sort());
  assert.ok((await pool.query(`SELECT 1 FROM site.mod_log WHERE action = 'memory_forget' AND target_id = $1`, [me])).rows.length, 'AI memory was not forgotten');
  assert.deepEqual([out.chatLog, out.quotes, out.supportEvents, out.links, out.live, out.profiles], [1, 1, 1, 1, 2, 1]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.bot_memory WHERE body LIKE '%aetest-lore%'`)).rows[0].n, 1, 'a shared note naming two people was deleted by one person\'s account deletion');

  const again = await ae.erase(me);
  assert.deepEqual([again.chatLog, again.quotes, again.supportEvents, again.links, again.profiles], [0, 0, 0, 0, 0], 'the erase is not idempotent');

  await t.test('the stream-side profile is gone and /user/lookup answers 404, even after an aggregate rebuild', async () => {
    const left = (await pool.query(`
      SELECT (SELECT count(*) FROM stream.users WHERE id = 'aetestcanon')::int AS users,
             (SELECT count(*) FROM stream.user_stats WHERE user_id = 'aetestcanon')::int AS stats,
             (SELECT count(*) FROM stream.nameidx WHERE canonical = 'aetestcanon')::int AS nameidx,
             (SELECT count(*) FROM stream.links WHERE canonical = 'aetestcanon')::int AS links,
             (SELECT count(*) FROM stream.chat_log WHERE user_id = 'aetestcanon')::int AS lines,
             (SELECT count(*) FROM stream.support_events WHERE user_id = 'aetestcanon')::int AS payments`)).rows[0];
    assert.deepEqual(left, { users: 0, stats: 0, nameidx: 0, links: 0, lines: 0, payments: 0 }, 'the stream-side profile of a deleted account survived');
    const kept = (await pool.query(`SELECT user_id, username, message, is_deleted FROM stream.chat_log WHERE id = $1`, [myLine])).rows[0];
    assert.deepEqual(kept, { user_id: ERASED_CANONICAL, username: '(deleted)', message: '', is_deleted: true }, 'the tombstoned line was lost, or still names the person');
    // Somebody else's profile is untouched.
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.links WHERE canonical = 'aetestother'`)).rows[0].n, 1);

    // /user/lookup, driven through the real route against a client inside one transaction, so the
    // aggregate rebuild below (a whole-table pass) is rolled back and never touches other suites' rows.
    await serially(pool, async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const db = { query: (...a) => client.query(...a) };
      const routes = {};
      registerProfileRoutes({ get: (p, ...h) => { routes[p] = h[h.length - 1]; } }, { pool: db, requireInternal: () => {}, wrap: (fn) => fn });
      const lookup = async (query) => {
        const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
        await routes['/user/lookup']({ query }, res);
        return res.statusCode;
      };
      const asked = [{ canonicalId: 'aetestcanon' }, { username: 'meontwitch' }, { platform: 'twitch', userId: 'tw-ae' }, { canonicalId: ERASED_CANONICAL }];
      for (const q of asked) assert.equal(await lookup(q), 404, `lookup ${JSON.stringify(q)} still answers before a rebuild`);
      await createAggregates({ pool: db, schedule: () => {} }).requestAggregateRefresh();
      // Vacuity: the rebuild really ran — the living person got a profile row from it.
      assert.equal(await lookup({ canonicalId: 'aetestother' }), 200, 'the aggregate rebuild did not run, so the 404s below prove nothing');
      for (const q of asked) assert.equal(await lookup(q), 404, `lookup ${JSON.stringify(q)} came back after an aggregate rebuild`);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM stream.user_stats WHERE user_id = $1`, [ERASED_CANONICAL])).rows[0].n, 0,
        'the erased-person row got a profile of its own (summed over every deleted account)');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    });
  });

  await t.test('after the erase their platform id starts a FRESH identity, and memory stays off for it', async () => {
    // The sponsor pool was told to drop them, by id and by every name it may hold them under.
    assert.equal(sponsorErased.length, 1, 'the sponsor pool was not told about the erase exactly once (the re-run finds nothing left)');
    assert.deepEqual(sponsorErased[0].canonicalIds, ['aetestcanon']);
    assert.ok(sponsorErased[0].names.map((n) => n.toLowerCase()).includes('meontwitch'), `the sponsor pool was not given their name: ${JSON.stringify(sponsorErased[0].names)}`);
    // The opt-out outlived the account, by platform id only.
    const carried = (await pool.query(`SELECT * FROM stream.memory_opt_out_platform_ids WHERE platform_id = ANY($1) ORDER BY platform_id`, [PLATFORM_IDS])).rows;
    assert.deepEqual(carried, [{ platform: 'twitch', platform_id: 'tw-ae' }], 'the opt-out was not carried onto their platform id (or it carried more than platform + id, or someone else\'s id)');
    // web removes the account's own opt-out row right after (accountDeletion.ts); do the same.
    await pool.query(`DELETE FROM site.memory_opt_outs WHERE matrix_id = $1`, [me]);

    // The same platform id chats again: a new canonical, not the old one (and not from a stale cache).
    const fresh = await identity.resolveOrCreate('twitch', 'tw-ae', 'meontwitch');
    assert.notEqual(fresh, 'aetestcanon', 'the erased identity was reattached to their platform id');
    assert.notEqual(fresh, ERASED_CANONICAL);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.users WHERE id = 'aetestcanon'`)).rows[0].n, 0, 'the old profile came back');

    // Memory never turns back on for them: the fresh identity's line is refused, a stranger's is not.
    const theirs = (await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, 'twitch', 'meontwitch', 'chatting again') RETURNING id`, [fresh])).rows[0].id;
    const strangers = (await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ('aetestother', 'twitch', 'someoneelse', 'a stranger talks') RETURNING id`)).rows[0].id;
    assert.equal(await memory.mayRemember({ source: 'platform', source_id: theirs }), false, 'the bot would remember someone who had opted out before deleting their account');
    assert.equal(await memory.mayRemember({ source: 'platform', source_id: strangers }), true, 'vacuity: the check refuses everyone');
    assert.equal(await memory.isPersonOptedOut({ canonicalId: fresh }), true);
    const people = await memory.optedOutPeople();
    assert.ok(people.canonicalIds.has(fresh), 'the offline backfills would still embed their fresh identity');
    assert.ok(!people.canonicalIds.has('aetestother'));
  });

  await t.test('a platform identity shared with ANOTHER site account is never reached: not its lines, not its memories, not the other account\'s', async () => {
    const victim = '@aetest-victim:x';
    const attacker = '@aetest-attacker:x';
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('aetestshared', 'sharedtw')`);
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Victim'), ($2, 'Attacker')`, [victim, attacker]);
    // Both site accounts linked to one platform identity (a split identity).
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-shared', 'aetestshared'), ($2, 'kick', 'kk-shared', 'aetestshared')`, [victim, attacker]);
    const shared = (await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ('aetestshared', 'twitch', 'sharedtw', 'victim words on twitch') RETURNING id`)).rows[0].id;
    const vNative = (await pool.query(`INSERT INTO site.chat_messages (matrix_id, message) VALUES ($1, 'victim site words') RETURNING id`, [victim])).rows[0].id;
    const vec = `[${Array.from({ length: 1536 }, () => 0.01).join(',')}]`;
    await pool.query(`INSERT INTO stream.message_embeddings (source, source_id, username, message, embedding) VALUES ('native', $1, 'Victim', 'aetest victim memory', $2::vector), ('platform', $3, 'sharedtw', 'aetest shared memory', $2::vector)`, [vNative, vec, shared]);

    const ids = await ae.exclusiveIdentities(attacker);
    assert.deepEqual([ids.matrixIds, ids.canonicalIds, ids.shared], [[attacker], [], ['aetestshared']]);
    await ae.erase(attacker);

    assert.equal((await pool.query(`SELECT message FROM stream.chat_log WHERE id = $1`, [shared])).rows[0].message, 'victim words on twitch', 'the attacker\'s erase tombstoned a line of a shared identity');
    const mem = (await pool.query(`SELECT message FROM stream.message_embeddings WHERE message LIKE 'aetest%' ORDER BY message`)).rows.map((r) => r.message);
    assert.deepEqual(mem, ['aetest shared memory', 'aetest victim memory'], 'the attacker\'s erase forgot someone else\'s memories');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.platform_links WHERE matrix_id = $1`, [victim])).rows[0].n, 1, 'the victim lost a link');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.users WHERE id = 'aetestshared'`)).rows[0].n, 1, 'the attacker\'s erase deleted a shared identity\'s profile');
  });

  await t.test('the route is behind the bearer secret, never IP trust', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'account-erase.js'), 'utf8');
    assert.match(src, /app\.post\('\/account\/erase', requireSecret, wrap/);
    assert.match(src, /module\.exports = \{ createAccountErase, ERASED_NAME, ERASED_CANONICAL, RESTRICTION_UPSERT_SQL \};\s*$/, 'vacuity: the file was read to its end');
  });

  // A TIMEOUT's restriction ends when the timeout does; a case never does.
  await t.test('/account/erase: a timed ban records its end; a case (or no end) records none; garbage is permanent', async () => {
    const routes = {};
    ae.registerAccountEraseRoutes({ post: (p, ...h) => { routes[p] = h[h.length - 1]; } }, { requireSecret: () => {}, wrap: (fn) => fn });
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const run = async (who, pid, body) => {
      const canon = pid.replace(/-/g, '');
      await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 't')`, [canon]);
      await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'T')`, [who]);
      await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('kick', $1, $2)`, [pid, canon]);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [who, pid, canon]);
      const res = { status() { return res; }, json() { return res; } };
      await routes['/account/erase']({ body: { matrixId: who, ...body } }, res);
      const row = (await pool.query(`SELECT reason, expires_at FROM stream.erased_restrictions WHERE platform = 'kick' AND platform_id = $1`, [pid])).rows[0];
      await pool.query(`DELETE FROM stream.erased_restrictions WHERE platform = 'kick' AND platform_id = $1`, [pid]);
      await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [who]);
      await pool.query(`DELETE FROM stream.links WHERE canonical = $1`, [canon]);
      await serially(pool, () => pool.query(`DELETE FROM stream.users WHERE id = $1`, [canon]));
      await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
      return row && { reason: row.reason, expires_at: row.expires_at && new Date(row.expires_at).toISOString() };
    };
    assert.deepEqual(await run('@aetest-to1:x', 'aetest-k1', { keepEvidence: true, keepLinks: true, restrictionExpiresAt: until }),
      { reason: 'ban', expires_at: until });
    assert.deepEqual(await run('@aetest-to2:x', 'aetest-k2', { keepEvidence: true, restrictionExpiresAt: until }),
      { reason: 'case', expires_at: null }, 'an open case must never expire');
    assert.deepEqual(await run('@aetest-to3:x', 'aetest-k3', { keepEvidence: true, keepLinks: true, restrictionExpiresAt: 'soon' }),
      { reason: 'ban', expires_at: null }, 'an unreadable end must keep the restriction, not drop it');
  });

  // Moderation retention is PRIVATE. A case keeps the words (mods-only) and a
  // ban keeps the record of which platform ids were the account's — but the profile is not public,
  // /user/lookup answers 404 like any unknown person, and new messages start a FRESH identity.
  await t.test('with an open case and a ban: words kept mods-only, the platform-id record kept privately — and the profile is NOT public', async () => {
    const who = '@aetest-banned:x';
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('aetestbanned', 'bannedtw')`);
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Banned')`, [who]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('${NATIVE_PLATFORM}', $1, 'aetestbanned'), ('twitch', 'tw-ban', 'aetestbanned')`, [who]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'tw-ban', 'aetestbanned')`, [who]);
    await pool.query(`INSERT INTO site.accounts (matrix_id, provider, provider_account_id) VALUES ($1, 'twitch', 'tw-ban') ON CONFLICT DO NOTHING`, [who]).catch(() => {});
    await pool.query(`INSERT INTO stream.user_stats (user_id, name, activity) VALUES ('aetestbanned', 'bannedtw', 3)`);
    assert.equal(await identity.resolveOrCreate('twitch', 'tw-ban', 'bannedtw'), 'aetestbanned');
    const line = (await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ('aetestbanned', 'twitch', 'bannedtw', 'the line the case is about') RETURNING id`)).rows[0].id;
    const out = await ae.erase(who, { keepEvidence: true, keepLinks: true });
    const r = (await pool.query(`SELECT message, is_deleted, user_id FROM stream.chat_log WHERE id = $1`, [line])).rows[0];
    assert.deepEqual([r.message, r.is_deleted], ['the line the case is about', true], 'the evidence was erased, or left public');
    assert.equal(r.user_id, ERASED_CANONICAL, 'the kept line still points at a public profile');
    assert.equal(out.profiles, 1, 'the banned person\'s profile stayed public');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM stream.users WHERE id = 'aetestbanned'`)).rows[0].n, 0);
    // The private record the ban needs lives OUTSIDE every identity table: nothing that expands a
    // canonical into accounts can fan out through it.
    const kept = (await pool.query(`SELECT platform, platform_id, matrix_id, reason FROM stream.erased_restrictions WHERE matrix_id = $1`, [who])).rows;
    assert.deepEqual(kept, [{ platform: 'twitch', platform_id: 'tw-ban', matrix_id: who, reason: 'ban' }], 'the ban lost its platform-id record');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.platform_links WHERE matrix_id = $1`, [who])).rows[0].n, 0,
      'a deleted account still holds an identity link');
    // Public visibility: /user/lookup answers 404 for every way of asking.
    const routes = {};
    registerProfileRoutes({ get: (p, ...h) => { routes[p] = h[h.length - 1]; } }, { pool, requireInternal: () => {}, wrap: (fn) => fn });
    const lookup = async (query) => { let code = 200; const res = { status: (c) => { code = c; return res; }, json: () => res }; await routes['/user/lookup']({ query }, res); return code; };
    for (const q of [{ canonicalId: 'aetestbanned' }, { userId: 'tw-ban', platform: 'twitch' }, { username: 'bannedtw' }]) {
      assert.equal(await lookup(q), 404, `lookup ${JSON.stringify(q)} still serves the deleted profile`);
    }
    // A new message from their platform id: a FRESH identity, never the old row, never the erased one.
    const fresh = await identity.resolveOrCreate('twitch', 'tw-ban', 'bannedtw');
    assert.ok(fresh !== 'aetestbanned' && fresh !== ERASED_CANONICAL, `the platform id reattached to ${fresh}`);
    assert.equal(await identity.resolveCanonical(null, who), null, 'the deleted account still resolves to an identity');
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM site.platform_links WHERE matrix_id = $1`, [who])).rows[0].n, 0,
      'the fresh identity was bound back to the deleted account');
    // ...and the fresh identity is STILL restricted: the deletion was no way out of the ban.
    const mark = (await pool.query(`SELECT source, platform, platform_user FROM site.user_marks WHERE canonical_id = $1 AND cleared_at IS NULL`, [fresh])).rows;
    assert.deepEqual(mark, [{ source: 'carried', platform: 'twitch', platform_user: 'tw-ban' }], 'the fresh identity walked away from the ban');
    await pool.query(`DELETE FROM site.accounts WHERE matrix_id = $1`, [who]).catch(() => {});
    await pool.query(`DELETE FROM site.user_marks WHERE canonical_id = $1`, [fresh]);
    await pool.query(`DELETE FROM stream.erased_restrictions WHERE matrix_id = $1`, [who]);
    await pool.query(`DELETE FROM stream.links WHERE platform = 'twitch' AND platform_id = 'tw-ban'`);
    await pool.query(`DELETE FROM stream.nameidx WHERE canonical = $1`, [fresh]);
    await serially(pool, () => pool.query(`DELETE FROM stream.users WHERE id = $1`, [fresh]));
  });

  // The payments the ledger could not price (or record) are anonymised too, found by the
  // platform ids captured before the links went.
  await t.test('their unpriced payments lose the name, message and platform id; the amounts stay', async () => {
    const who = '@aetest-unpriced:x';
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('aetestunpr', 'paytw')`);
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Payer')`, [who]);
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ('aetestnameowner', 'otherguy')`);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('${NATIVE_PLATFORM}', $1, 'aetestunpr'), ('youtube', 'yt-ae', 'aetestunpr'), ('streamlabs', 'name:paytw', 'aetestunpr'), ('streamlabs', 'name:otherguy', 'aetestunpr')`, [who]);
    // 'paytw' is theirs; 'otherguy' is somebody else's name (its first owner), however it got linked.
    await pool.query(`INSERT INTO stream.nameidx (name_lower, canonical) VALUES ('paytw', 'aetestunpr'), ('otherguy', 'aetestnameowner')`);
    await pool.query(`INSERT INTO stream.unpriced_support (event_id, platform, event_type, user_id, username, amount_native, currency, raw, message) VALUES
      ('aetest-up-1', 'youtube', 'superchat', 'yt-ae', 'paytw', 5000, 'UNKNOWN', 'F CFA 5,000', 'my message'),
      ('aetest-up-2', 'streamlabs', 'donation', NULL, 'PayTW', 10, 'XXX', '10 XXX', 'hello'),
      ('aetest-up-3', 'youtube', 'superchat', 'yt-someone-else', 'other', 1, 'UNKNOWN', '1', 'keep me'),
      ('aetest-up-4', 'streamlabs', 'donation', NULL, 'OtherGuy', 7, 'XXX', '7 XXX', 'not theirs')`);
    try {
      const out = await ae.erase(who);
      assert.equal(out.unpriced, 2);
      const rows = (await pool.query(`SELECT event_id, user_id, username, message, amount_native::float AS amount, currency FROM stream.unpriced_support WHERE event_id LIKE 'aetest-up-%' ORDER BY event_id`)).rows;
      assert.deepEqual(rows, [
        { event_id: 'aetest-up-1', user_id: null, username: '(deleted)', message: null, amount: 5000, currency: 'UNKNOWN' },
        { event_id: 'aetest-up-2', user_id: null, username: '(deleted)', message: null, amount: 10, currency: 'XXX' },
        { event_id: 'aetest-up-3', user_id: 'yt-someone-else', username: 'other', message: 'keep me', amount: 1, currency: 'UNKNOWN' },
        { event_id: 'aetest-up-4', user_id: null, username: 'OtherGuy', message: 'not theirs', amount: 7, currency: 'XXX' },
      ], 'an unpriced payment kept their name/message/id, or someone else\'s (a typed name they do not own) was touched');
    } finally {
      await pool.query(`DELETE FROM stream.unpriced_support WHERE event_id LIKE 'aetest-up-%'`);
      await pool.query(`DELETE FROM stream.nameidx WHERE canonical = 'aetestnameowner'`);
      await serially(pool, () => pool.query(`DELETE FROM stream.users WHERE id = 'aetestnameowner'`));
    }
  });
});
