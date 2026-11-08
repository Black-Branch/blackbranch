// "Is this person banned?" — ONE rule, run through BOTH readers against a REAL Postgres
// (config/canonical-standing.mjs states it):
//   • an account's truth is site.bans; a canonical's truth is its OWN site.mod_log rows by id;
//   • banned when either says so — Allow (web platformRetry.ts bannedNow) and the chat door
//     (ban-hold.js, inside its 15-minute bridge) answer the same;
//   • web writes an account's ban / timeout / unban onto the canonicals linked at that moment;
//   • a merge carries the loser's STANDING to the survivor as a new row, never weakening it.
// Each case is its own person; every reader is asked twice and through a fresh hold (a restart).
// Fixtures are scoped to canonicals `ab5…` and accounts `@bs5-…` and removed before and after.
// Run: SQL_PARSE_DATABASE_URL=… node --test ban-standing.db.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createIdentity } = require('./identity');
const { createBanHold } = require('./ban-hold');
const { serially } = require('./testlib/db-serial.js');

const URL = process.env.SQL_PARSE_DATABASE_URL || '';
const MOD = '@bs5-mod:site.test';
const quietLog = { warn() {}, log() {}, error() {} };
const quiet = (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; return Promise.resolve().then(fn).finally(() => { console.warn = w; console.log = l; }); };

test('one standing rule, both readers', async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, 'SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there');
    t.skip('SQL_PARSE_DATABASE_URL not set');
    return;
  }
  const { bannedNow } = await import('../web/app/lib/platformRetry.ts');
  const { LIFT_BAN_SQL } = await import('../web/app/lib/community/unbans.ts');
  const { BAN_ACCOUNT_SQL } = await import('../web/app/lib/community/accountBans.ts');
  const { timeoutPostResponse, timeoutDeleteResponse } = await import('../web/app/lib/community/modTimeout.ts');
  const pool = new Pool({ connectionString: URL, max: 4 });
  const q = (sql, p) => pool.query(sql, p);
  const clean = () => serially(pool, async () => {
    await pool.query(`DELETE FROM site.mod_log WHERE target_id LIKE 'ab5%' OR target_id LIKE '@bs5-%'`);
    await pool.query(`DELETE FROM site.community_unbans WHERE matrix_id LIKE '@bs5-%'`);
    await pool.query(`DELETE FROM site.bans WHERE matrix_id LIKE '@bs5-%'`);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id LIKE '@bs5-%'`);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id LIKE 'ab5%'`);
    await pool.query(`DELETE FROM stream.links WHERE canonical LIKE 'ab5%' OR platform_id LIKE 'bs5-%' OR platform_id LIKE '@bs5-%'`);
    await pool.query(`DELETE FROM stream.user_stats WHERE user_id LIKE 'ab5%'`);
    await pool.query(`DELETE FROM stream.users WHERE id LIKE 'ab5%'`);
    await pool.query(`DELETE FROM site.users WHERE matrix_id LIKE '@bs5-%'`);
  });
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'mod')`, [MOD]);
  const identity = createIdentity({ pool, requestAggregateRefresh: () => {} });

  let seq = 0;
  /** A Kick chatter with no site account: canonical + its platform link. */
  const chatter = async (firstSeenDaysAgo = 0) => {
    seq += 1;
    const c = `ab5${String(seq).padStart(9, '0')}`;
    const pid = `bs5-k${seq}`;
    await pool.query(`INSERT INTO stream.users (id, name, first_seen) VALUES ($1, 'x', now() - make_interval(days => $2))`, [c, firstSeenDaysAgo]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('kick', $1, $2)`, [pid, c]);
    return { c, pid };
  };
  /** A mod_log row on a target, `agoMin` minutes back (created_at only — the rule reads ids). */
  const log = (target, action, agoMin = 0, expiresInMin = null) => pool.query(
    `INSERT INTO site.mod_log (action, target_id, performed_by, expires_at, created_at)
     VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(mins => $4::int) END,
             now() - make_interval(mins => $5::int))`, [action, target, MOD, expiresInMin, agoMin]);
  /** They sign up (an account + its native canonical) and link the Kick account: platform_links + the
   *  merge gatherIdentity runs. `siteSurvives` picks which canonical the merge keeps. Returns the survivor. */
  const signUpAndLink = async (k, { siteSurvives = true, before } = {}) => {
    seq += 1;
    const m = `@bs5-u${seq}:site.test`;
    const n = `ab5${String(seq).padStart(9, '0')}`;
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
    await pool.query(`INSERT INTO stream.users (id, name, first_seen) VALUES ($1, 'x', now() - make_interval(days => $2))`, [n, siteSurvives ? 30 : 0]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2)`, [m, n]);
    if (!siteSurvives) await pool.query(`UPDATE stream.users SET first_seen = now() - interval '60 days' WHERE id = $1`, [k.c]);
    if (before) await before(m);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [m, k.pid, k.c]);
    const out = await quiet(() => identity.mergeCanonicals([n, k.c]));
    assert.equal(out.survivor, siteSurvives ? n : k.c, 'precondition: the survivor');
    return { m, s: out.survivor };
  };
  /** Both readers, each asked twice; the chat door through a running hold and a restarted one. */
  const judge = async (c, pid) => {
    const allow = [await bannedNow(c, q), await bannedNow(c, q)];
    assert.equal(allow[0], allow[1], 'Allow answered two ways from the same rows');
    const door = [];
    for (const h of [createBanHold({ pool, log: quietLog }), createBanHold({ pool, log: quietLog })]) {
      await h.refresh(); await h.refresh();
      door.push(h.isHeld(c, 'kick', pid));
    }
    assert.equal(door[0], door[1], 'the chat door answered two ways from the same rows (restart)');
    assert.equal(allow[0], door[0], `the two readers disagree for ${c}: Allow ${allow[0]}, chat door ${door[0]}`);
    return allow[0];
  };
  const rowsOn = async (c) => (await pool.query(
    `SELECT action, performed_by, reason FROM site.mod_log WHERE target_id = $1 ORDER BY id`, [c])).rows;

  await t.test('a platform-only ban stands through signing up and linking (both survivor orders)', async () => {
    for (const siteSurvives of [true, false]) {
      const k = await chatter();
      await log(k.c, 'ban', 5);
      const { s } = await signUpAndLink(k, { siteSurvives });
      assert.equal(await judge(s, k.pid), true, `linking lifted a platform-only ban (site survives: ${siteSurvives})`);
    }
  });

  await t.test('a site unban of the account after the link lifts it, by writing an unban on the canonical', async () => {
    for (const siteSurvives of [true, false]) {
      const k = await chatter();
      await log(k.c, 'ban', 5);
      const { m, s } = await signUpAndLink(k, { siteSurvives });
      await pool.query(LIFT_BAN_SQL, [m, MOD, '00000000-0000-4000-8000-000000000005']);
      assert.equal(await judge(s, k.pid), false, `a site unban did not lift the ban (site survives: ${siteSurvives})`);
      assert.deepEqual((await rowsOn(s)).at(-1), { action: 'unban', performed_by: MOD, reason: `lifted with ${m}` });
    }
  });

  await t.test('an expired site timeout of the account, from before the link, lifts nothing', async () => {
    const k = await chatter();
    await log(k.c, 'ban', 30);
    const { s } = await signUpAndLink(k, { before: async (m) => {
      await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, now() - interval '1 minute')`, [m, MOD]);
      await log(m, 'timeout', 10, -1);   // newer than the platform ban, already over
    } });
    assert.equal(await judge(s, k.pid), true, 'an expired site timeout outranked a standing platform ban');
  });

  await t.test('a site unban for an earlier matter, from before the link, lifts nothing', async () => {
    const k = await chatter();
    await log(k.c, 'ban', 30);
    const { s } = await signUpAndLink(k, { before: async (m) => { await log(m, 'unban', 10); } });
    assert.equal(await judge(s, k.pid), true, 'an older-matter site unban lifted a platform ban');
  });

  await t.test('a canonical: a timeout never weakens a ban; an ended timeout is nothing; a later ban re-bans', async () => {
    const a = await chatter();
    await log(a.c, 'ban', 3); await log(a.c, 'timeout', 1, 10);
    assert.equal(await judge(a.c, a.pid), true, 'a timeout after a ban weakened it');
    const b = await chatter();
    await log(b.c, 'timeout', 3, -1);
    assert.equal(await judge(b.c, b.pid), false, 'an ended timeout still bans');
    const c = await chatter();
    await log(c.c, 'timeout', 3, 10);
    assert.equal(await judge(c.c, c.pid), true, 'a running timeout does not ban');
    const d = await chatter();
    await log(d.c, 'ban', 3); await log(d.c, 'unban', 2);
    assert.equal(await judge(d.c, d.pid), false, 'an unban did not lift the ban before it');
    await log(d.c, 'ban', 1);
    assert.equal(await judge(d.c, d.pid), true, 'a ban after an unban did not ban again');
    // Insertion order decides, not created_at: an unban inserted LATER but dated earlier still lifts.
    const e = await chatter();
    await log(e.c, 'ban', 1); await log(e.c, 'unban', 60);
    assert.equal(await judge(e.c, e.pid), false, 'the rule read created_at instead of insertion order');
  });

  await t.test('merge: the loser\'s ban is carried over the survivor\'s older unban as a new row; a site unban then lifts it', async () => {
    const k = await chatter();
    await log(k.c, 'ban', 30);
    const { m, s } = await signUpAndLink(k, { before: async (acct) => {
      const n = (await pool.query(`SELECT canonical FROM stream.links WHERE platform = 'native' AND platform_id = $1`, [acct])).rows[0].canonical;
      await log(n, 'ban', 20); await log(n, 'unban', 10);   // the survivor's own older matter, newer than the loser's ban by time
    } });
    assert.equal(await judge(s, k.pid), true, 'the survivor\'s older unban buried the carried ban');
    const carried = (await rowsOn(s)).at(-1);
    assert.deepEqual(carried, { action: 'ban', performed_by: 'system', reason: `carried by merge from ${k.c}` });
    assert.equal((await pool.query(`SELECT created_at > now() - interval '1 minute' AS fresh FROM site.mod_log WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [s])).rows[0].fresh, true,
      'the carried row kept the loser\'s old time');
    assert.deepEqual(await rowsOn(k.c), [{ action: 'ban', performed_by: MOD, reason: null }], 'the loser\'s own row moved or went');
    await pool.query(LIFT_BAN_SQL, [m, MOD, '00000000-0000-4000-8000-000000000006']);
    assert.equal(await judge(s, k.pid), false, 'a site unban after the carry did not lift it');
  });

  // Round 10: a merge carries EVERY standing row of the loser. Standing is a union of rows, so one
  // more never weakens it — and leaving one behind (as the old "never weaken" filter did) left it
  // covered only by a survivor row an account can lift on its own.
  await t.test('a merge carries every standing row of the loser; the survivor stays banned', async () => {
    const pairs = [];
    for (const [survivorRows, loserRows, carries] of [
      [[['ban']], [['timeout', 60]], 1],              // survivor banned; loser timed out
      [[['ban']], [['ban']], 1],                      // both banned
      [[['timeout', 120]], [['timeout', 30]], 1],     // the loser's timeout is shorter: carried all the same
      [[['timeout', 30]], [['timeout', 120]], 1],     // the loser's timeout is longer
      [[], [['ban'], ['timeout', 60]], 2],            // a clean survivor: both of the loser's rows
    ]) {
      const s = await chatter(30);
      const l = await chatter(0);
      for (const [a, mins] of survivorRows) await log(s.c, a, 5, mins ?? null);
      for (const [a, mins] of loserRows) await log(l.c, a, 5, mins ?? null);
      const before = (await rowsOn(s.c)).length;
      assert.equal((await quiet(() => identity.mergeCanonicals([s.c, l.c]))).survivor, s.c, 'precondition: the older survives');
      assert.equal((await rowsOn(s.c)).length - before, carries, `carried wrongly: ${JSON.stringify({ survivorRows, loserRows })}`);
      assert.equal(await judge(s.c, s.pid), true);
      pairs.push([s.c, l.c]);
    }
    // The longer timeout carried runs to the loser's end, not the survivor's.
    const [sLong] = pairs[3];
    const until = (await pool.query(
      `SELECT expires_at > now() + interval '100 minutes' AS longer FROM site.mod_log WHERE target_id = $1 ORDER BY id DESC LIMIT 1`, [sLong])).rows[0];
    assert.equal(until.longer, true, 'the carried timeout did not keep the loser\'s end');
    // RETRY: a second merge of the same pairs carries nothing twice.
    for (const p of pairs) {
      const before = (await rowsOn(p[0])).length;
      await quiet(() => identity.mergeCanonicals(p));
      assert.equal((await rowsOn(p[0])).length, before, 'a retried merge carried again');
    }
  });

  await t.test('a site ban or timeout of an account reaches its linked canonicals; ending a timeout early frees at once', async () => {
    const deps = (who) => ({
      db: { query: (sql, params) => pool.query(sql, params) },
      mod: MOD,
      ceiling: async () => null,
      log: async () => {}, pushChat: async () => {}, fanOut: () => [], fanOutLift: () => [],
      reconcile: async () => true,
      batchId: () => `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      logError: () => { throw new Error(`timeout failed for ${who}`); },
    });
    const req = (body, method) => new Request('http://x/api/mod/timeout', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // A clean linked person: timed out on the site → both readers ban; the timeout ended early → free.
    const k = await chatter();
    const { m, s } = await signUpAndLink(k);
    assert.equal(await judge(s, k.pid), false, 'precondition: a clean person');
    assert.equal((await timeoutPostResponse(req({ userId: m, minutes: 60, reason: 'spam' }, 'POST'), deps(m))).status, 200);
    assert.equal(await judge(s, k.pid), true, 'a site timeout did not reach the linked canonical');
    assert.equal((await rowsOn(s)).at(-1).reason, `timed out with ${m}`);
    const lifted = await timeoutDeleteResponse(req({ userId: m }, 'DELETE'), deps(m));
    assert.deepEqual(await lifted.json().then((b) => [lifted.status, b.lifted]), [200, true]);
    assert.equal(await judge(s, k.pid), false, 'ending a site timeout early did not free the person');

    // A platform ban from before the link + a site timeout ended early: the ban still stands.
    const k2 = await chatter();
    await log(k2.c, 'ban', 5);
    const linked = await signUpAndLink(k2);
    assert.equal((await timeoutPostResponse(req({ userId: linked.m, minutes: 10, reason: 'spam' }, 'POST'), deps(linked.m))).status, 200);
    await timeoutDeleteResponse(req({ userId: linked.m }, 'DELETE'), deps(linked.m));
    assert.equal(await judge(linked.s, k2.pid), true, 'ending a timeout lifted a ban');

    // A site BAN (the Mod Panel's statement) reaches the canonical and stays on it after an unlink.
    const k3 = await chatter();
    const b = await signUpAndLink(k3);
    await pool.query(BAN_ACCOUNT_SQL, [b.m, MOD, 'abuse', null, 'ban', null, '00000000-0000-4000-8000-000000000007', [b.m]]);
    assert.equal(await judge(b.s, k3.pid), true);
    assert.deepEqual((await rowsOn(b.s)).at(-1), { action: 'ban', performed_by: MOD, reason: `banned with ${b.m}` });
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [b.m]);
    await pool.query(`DELETE FROM stream.links WHERE platform = 'native' AND platform_id = $1`, [b.m]);
    assert.equal(await bannedNow(b.s, q), true, 'unlinking took the ban off the canonical');
    // A canonical linked LATER gets nothing from the earlier site action.
    const k4 = await chatter();
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [b.m, k4.pid, k4.c]);
    assert.equal(await bannedNow(k4.c, q), true, 'a running site ban of the account does not hold a canonical linked to it now');
    assert.deepEqual(await rowsOn(k4.c), [], 'a later link rewrote history onto the canonical');
  });

  // Round 6 (gate on f952002e): a mod's deliberate REDUCTION (override, or the panel's Undo) replaces
  // the account's row with a weaker one; the canonical must be reduced too, or its earlier ban (a
  // timeout never weakens it) or longer timeout outlives the account's.
  await t.test('a reduction of an account\'s ban or timeout reduces its canonicals: free when the new timeout ends', async () => {
    const at = (min) => `now() + make_interval(mins => ${min})`;
    const banAccount = async (m, minutes, covered = [m]) => {
      const until = minutes == null ? null : (await pool.query(`SELECT (${at(minutes)})::text AS t`)).rows[0].t;
      const { rows } = await pool.query(BAN_ACCOUNT_SQL, [m, MOD, 'abuse', until, minutes == null ? 'ban' : 'timeout', minutes, `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, covered]);
      return rows[0].kept_identities.length;
    };
    /** Time passes past every running timeout of the person (the account's row and its canonical's). */
    const timePasses = async (m, c) => {
      await pool.query(`UPDATE site.bans SET expires_at = now() - interval '1 second' WHERE matrix_id = $1 AND expires_at IS NOT NULL`, [m]);
      await pool.query(`UPDATE site.mod_log SET expires_at = now() - interval '1 second' WHERE target_id = $1 AND action = 'timeout'`, [c]);
    };
    for (const [name, first, then] of [
      ['ban → override to a 10-minute timeout', null, 10],
      ['60-minute timeout → override to 10', 60, 10],
      ['Undo: a ban over a running 60-minute timeout, put back to the timeout', null, 60],
    ]) {
      const k = await chatter();
      const { m, s } = await signUpAndLink(k);
      await banAccount(m, first);
      assert.equal(await judge(s, k.pid), true, `${name}: precondition`);
      await banAccount(m, then);
      assert.equal(await judge(s, k.pid), true, `${name}: the new timeout runs`);
      const tail = (await rowsOn(s)).slice(-2).map((r) => [r.action, r.reason]);
      assert.deepEqual(tail, [['unban', `reduced with ${m}`], ['timeout', `timed out with ${m}`]], `${name}: the unban must come before (lower id than) the new timeout`);
      await timePasses(m, s);
      assert.equal(await judge(s, k.pid), false, `${name}: the account is free and the canonical stayed banned`);
    }
    // An EXTENSION (10 → 60, or a timeout → a ban) reduces nothing: no unban, and a canonical's own
    // platform ban from before the link is never lifted by it.
    const k = await chatter();
    await log(k.c, 'ban', 5);
    const { m, s } = await signUpAndLink(k);
    await banAccount(m, 10); await banAccount(m, 60); await banAccount(m, null);
    assert.equal((await rowsOn(s)).filter((r) => r.action === 'unban').length, 0, 'an extension wrote an unban');
    assert.equal(await judge(s, k.pid), true);

    // Round 7: a reduction lifts only what THIS account's actions placed on the canonical — never the
    // canonical's own standing (a platform ban from before the link, a merge-carried one).
    // (1) The gate's sequence: platform ban → link → site timeout 60 → shortened to 10.
    {
      const k1 = await chatter();
      await log(k1.c, 'ban', 5);
      const p = await signUpAndLink(k1);
      assert.equal(await banAccount(p.m, 60), 0, 'an extension is not a reduction');
      assert.equal(await banAccount(p.m, 10), 1, 'the mod is not told the identity keeps its own ban');
      // Our timeout is lifted and the identity's own ban (carried into the survivor by the link's
      // merge) is placed again above the unban, then the shorter timeout.
      assert.deepEqual((await rowsOn(p.s)).slice(-3).map((r) => [r.action, r.reason]),
        [['unban', `reduced with ${p.m}`], ['ban', `carried by merge from ${k1.c}`], ['timeout', `timed out with ${p.m}`]],
        'shortening a timeout lifted the identity\'s own ban');
      assert.equal(await judge(p.s, k1.pid), true, 'shortening a timeout freed a platform-banned identity');
      await timePasses(p.m, p.s);
      assert.equal(await judge(p.s, k1.pid), true, 'ten minutes later the identity\'s own ban was gone');
    }
    // (2) A permanent account ban reduced to a timeout, the canonical's only ban being "banned with"
    //     this account: lifted at the timeout's end (and nothing kept).
    {
      const k2 = await chatter();
      const p = await signUpAndLink(k2);
      await banAccount(p.m, null);
      assert.equal(await banAccount(p.m, 10), 0);
      assert.equal(await judge(p.s, k2.pid), true);
      await timePasses(p.m, p.s);
      assert.equal(await judge(p.s, k2.pid), false, 'the account\'s own ban outlived its reduction on the identity');
    }
    // (3) The same, but the canonical also has an older ban of its own: it stays banned.
    {
      const k3 = await chatter();
      await log(k3.c, 'ban', 30);
      const p = await signUpAndLink(k3);
      await banAccount(p.m, null);
      assert.equal(await banAccount(p.m, 10), 1);
      await timePasses(p.m, p.s);
      assert.equal(await judge(p.s, k3.pid), true, 'a reduction of the account lifted the identity\'s older own ban');
      // Only a full site Unban lifts it.
      await pool.query(LIFT_BAN_SQL, [p.m, MOD, '00000000-0000-4000-8000-00000000000c']);
      assert.equal(await judge(p.s, k3.pid), false, 'a full Unban did not lift the identity');
    }

    // Round 8 — the MIXED case: the identity also holds a row this account did not place. The
    // reduction still lifts this account's rows and places the others again (new, higher ids).
    // (A) its own pre-link 5-minute timeout + our permanent ban, reduced to 10 → free at 10, kept 0.
    {
      const kA = await chatter();
      await log(kA.c, 'timeout', 1, 5);
      const p = await signUpAndLink(kA);
      await banAccount(p.m, null);
      assert.equal(await banAccount(p.m, 10), 0, 'a 5-minute timeout of its own was reported as kept past a 10-minute one');
      const tail = (await rowsOn(p.s)).slice(-3).map((r) => [r.action, r.reason]);
      assert.deepEqual(tail, [['unban', `reduced with ${p.m}`], ['timeout', `carried by merge from ${kA.c}`], ['timeout', `timed out with ${p.m}`]],
        '(A) not: unban, then the own timeout placed again, then the new timeout');
      assert.equal(await judge(p.s, kA.pid), true);
      await timePasses(p.m, p.s);
      assert.equal(await judge(p.s, kA.pid), false, '(A) our permanent ban outlived its reduction because the identity had a row of its own');
    }
    // (B) one identity shared by two accounts, banned through it and reduced through it (the route
    //     covers both accounts): free at 10, counted 0 — never twice.
    {
      const kB = await chatter();
      seq += 1;
      const A = `@bs5-sa${seq}:site.test`, B = `@bs5-sb${seq}:site.test`;
      await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'a'), ($2, 'b')`, [A, B]);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $3, $4), ($2, 'twitch', $5, $4)`,
        [A, B, kB.pid, kB.c, `bs5-tw${seq}`]);
      const covered = [A, B];
      for (const m of covered) await banAccount(m, null, covered);
      let kept = 0;
      for (const m of covered) kept += await banAccount(m, 10, covered);
      assert.equal(kept, 0, '(B) a shared identity was reported as keeping its own ban');
      assert.equal(await judge(kB.c, kB.pid), true);
      for (const m of covered) await timePasses(m, kB.c);
      assert.equal(await judge(kB.c, kB.pid), false, '(B) each account saw the other\'s row as not ours and nothing was lifted');
    }
  });

  // Round 9 — a merge keeps the placing account's provenance. The reason is how a lift tells what an
  // account placed; a carried row used to read only "carried by merge from <loser>", so after a merge
  // ending A's timeout lifted nothing (yet answered lifted) and a reduction kept A's ban.
  await t.test('after a merge, ending the account\'s timeout and reducing its ban still find what it placed', async () => {
    const deps = (m) => ({
      db: { query: (sql, params) => pool.query(sql, params) }, mod: MOD, ceiling: async () => null,
      log: async () => {}, pushChat: async () => {}, fanOut: () => [], fanOutLift: () => [], reconcile: async () => true,
      batchId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      logError: () => { throw new Error(`timeout failed for ${m}`); },
    });
    const req = (body, method) => new Request('http://x/api/mod/timeout', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    /** Account A with its native canonical and a linked Kick identity C1; C2 (older — the merge's
     *  survivor) is linked only AFTER the action, so it holds A's row only through the carry. */
    const person = async () => {
      seq += 1;
      const A = `@bs5-pv${seq}:site.test`;
      const n = `ab5${String(seq).padStart(9, '0')}`;
      await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [A]);
      await pool.query(`INSERT INTO stream.users (id, name, first_seen) VALUES ($1, 'x', now())`, [n]);
      await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2)`, [A, n]);
      const c1 = await chatter(0);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [A, c1.pid, c1.c]);
      const c2 = await chatter(90);
      const linkAndMerge = async () => {
        await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3)`, [A, c2.pid, c2.c]);
        const out = await quiet(() => identity.mergeCanonicals([c2.c, c1.c, n]));
        assert.equal(out.survivor, c2.c, 'precondition: the older identity survives');
      };
      return { A, c2, linkAndMerge };
    };

    // A timeout on A → merge → ended early: C2 free in both readers, and the answer is true.
    {
      const { A, c2, linkAndMerge } = await person();
      assert.equal((await timeoutPostResponse(req({ userId: A, minutes: 60, reason: 'spam' }, 'POST'), deps(A))).status, 200);
      await linkAndMerge();
      const carried = (await rowsOn(c2.c)).at(-1);
      assert.match(carried.reason, new RegExp(`^timed out with ${A.replace(/[.]/g, '\\.')} · carried by merge from ab5`), 'the carry dropped the placing account');
      assert.equal(await judge(c2.c, c2.pid), true);
      const res = await timeoutDeleteResponse(req({ userId: A }, 'DELETE'), deps(A));
      assert.deepEqual([res.status, (await res.json()).lifted], [200, true]);
      assert.equal(await judge(c2.c, c2.pid), false, 'after a merge, ending the account\'s timeout left the survivor timed out');
    }
    // A ban on A → merge → reduced to 10 → free at 10, nothing kept.
    {
      const { A, c2, linkAndMerge } = await person();
      await pool.query(BAN_ACCOUNT_SQL, [A, MOD, 'abuse', null, 'ban', null, `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, [A]]);
      await linkAndMerge();
      assert.equal(await judge(c2.c, c2.pid), true);
      const until = (await pool.query(`SELECT (now() + interval '10 minutes')::text AS t`)).rows[0].t;
      const { rows } = await pool.query(BAN_ACCOUNT_SQL, [A, MOD, 'abuse', until, 'timeout', 10, `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, [A]]);
      assert.deepEqual(rows[0].kept_identities, [], 'the carried ban A placed was reported as the identity\'s own');
      assert.equal(await judge(c2.c, c2.pid), true, 'the 10-minute timeout runs');
      await pool.query(`UPDATE site.bans SET expires_at = now() - interval '1 second' WHERE matrix_id = $1`, [A]);
      await pool.query(`UPDATE site.mod_log SET expires_at = now() - interval '1 second' WHERE target_id = $1 AND action = 'timeout'`, [c2.c]);
      assert.equal(await judge(c2.c, c2.pid), false, 'after a merge, a reduction re-placed the ban A placed instead of lifting it');
    }
  });

  // Round 10 — the gate's two sequences: the survivor's only row was one account A placed, the loser
  // held a row of its own. Before, the merge dropped the loser's row ("never weaken"), so A's lift left
  // the person free and the identity's own row gone.
  await t.test('a loser\'s own row survives a merge into an account-placed survivor and that account\'s lift', async () => {
    const deps = (m) => ({
      db: { query: (sql, params) => pool.query(sql, params) }, mod: MOD, ceiling: async () => null,
      log: async () => {}, pushChat: async () => {}, fanOut: () => [], fanOutLift: () => [], reconcile: async () => true,
      batchId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      logError: () => { throw new Error(`timeout failed for ${m}`); },
    });
    const req = (body, method) => new Request('http://x/api/mod/timeout', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    /** Account A linked to C2 (older, the survivor); C1 is a chatter with a row of its own, linked later. */
    const setup = async () => {
      seq += 1;
      const A = `@bs5-cv${seq}:site.test`;
      await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [A]);
      const c2 = await chatter(90);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3)`, [A, c2.pid, c2.c]);
      const c1 = await chatter(0);
      const merge = async () => {
        await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [A, c1.pid, c1.c]);
        assert.equal((await quiet(() => identity.mergeCanonicals([c2.c, c1.c]))).survivor, c2.c, 'precondition: C2 survives');
      };
      return { A, c1, c2, merge };
    };

    // Timeout: C2 holds "timed out with A" 60 min; C1 its own 30-minute mod timeout. A's timeout ended
    // early → C2 stays timed out by C1's own timeout, placed again.
    {
      const { A, c1, c2, merge } = await setup();
      assert.equal((await timeoutPostResponse(req({ userId: A, minutes: 60, reason: 'spam' }, 'POST'), deps(A))).status, 200);
      await log(c1.c, 'timeout', 1, 30);
      await merge();
      const res = await timeoutDeleteResponse(req({ userId: A }, 'DELETE'), deps(A));
      assert.deepEqual([res.status, (await res.json()).lifted], [200, true]);
      assert.equal(await judge(c2.c, c2.pid), true, 'ending A\'s timeout freed a person whose identity holds a timeout of its own');
      assert.deepEqual((await rowsOn(c2.c)).slice(-2).map((r) => [r.action, r.reason]),
        [['unban', `timeout ended with ${A}`], ['timeout', `carried by merge from ${c1.c}`]], 'the identity\'s own timeout was not placed again');
    }
    // Ban: C2 holds "banned with A"; C1 its own platform ban. A reduced to 10 → C2 stays banned, and
    // the reduction names it as keeping its own ban.
    {
      const { A, c1, c2, merge } = await setup();
      await pool.query(BAN_ACCOUNT_SQL, [A, MOD, 'abuse', null, 'ban', null, `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, [A]]);
      await log(c1.c, 'ban', 5);
      await merge();
      const until = (await pool.query(`SELECT (now() + interval '10 minutes')::text AS t`)).rows[0].t;
      const { rows } = await pool.query(BAN_ACCOUNT_SQL, [A, MOD, 'abuse', until, 'timeout', 10, `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, [A]]);
      assert.deepEqual(rows[0].kept_identities, [c2.c], 'the reduction did not name the identity keeping its own ban');
      assert.deepEqual((await rowsOn(c2.c)).slice(-3).map((r) => r.action), ['unban', 'ban', 'timeout'], 'the identity\'s own ban was not placed again');
      await pool.query(`UPDATE site.bans SET expires_at = now() - interval '1 second' WHERE matrix_id = $1`, [A]);
      await pool.query(`UPDATE site.mod_log SET expires_at = now() - interval '1 second' WHERE target_id = $1 AND action = 'timeout'`, [c2.c]);
      assert.equal(await judge(c2.c, c2.pid), true, 'a permanently platform-banned person chats after A\'s reduction ran out');
    }
  });

  // Round 11 — Retry (platformRetry.ts) re-runs a failed fan-out only while its batch is the target's
  // newest ban/timeout/unban. A merge's carried row is new (now(), no batch); read as the newest action,
  // it refused the Retry ("Too old to retry") and a failed Kick ban was never applied.
  await t.test('a merge never supersedes a failed fan-out\'s Retry; a newer mod action still does', async () => {
    const { newestActions, standingOf } = await import('../web/app/lib/platformRetry.ts');
    const { CANONICAL_ACTION_SQL } = await import('../web/app/lib/community/accountBans.ts');
    const X = '00000000-0000-4000-8000-0000000000a1', Y = '00000000-0000-4000-8000-0000000000a2';
    const retry = async (c) => standingOf({ action: 'ban', batch_id: X }, (await newestActions([c], q)).get(c));
    // A mod bans platform-only S (the Kick fan-out of batch X fails); L holds a row of its own.
    const S = await chatter(90);
    const L = await chatter(0);
    await pool.query(CANONICAL_ACTION_SQL, ['ban', S.c, MOD, null, null, 'spam', X]);
    await log(L.c, 'ban', 5);
    assert.deepEqual(await retry(S.c), { ok: true, durationSeconds: null }, 'precondition: Retry allowed');
    // The person signs up and links both: the merge carries L's row onto S.
    seq += 1;
    const M = `@bs5-rt${seq}:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [M]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($1, 'kick', $4, $5)`,
      [M, S.pid, S.c, L.pid, L.c]);
    assert.equal((await quiet(() => identity.mergeCanonicals([S.c, L.c]))).survivor, S.c, 'precondition: S survives');
    assert.match((await rowsOn(S.c)).at(-1).reason, /^carried by merge from /, 'precondition: a carried row is the newest');
    assert.deepEqual(await retry(S.c), { ok: true, durationSeconds: null }, 'a merge\'s carried row refused the Retry of the mod\'s ban');
    // A genuinely newer mod action still supersedes it.
    await pool.query(CANONICAL_ACTION_SQL, ['unban', S.c, MOD, null, null, null, Y]);
    assert.deepEqual(await retry(S.c), { ok: false, supersededBy: 'unban' }, 'a later unban no longer supersedes the Retry');

    /** A platform-only S with `act` (batch `batch`, its fan-out failed), then L with a row of its own
     *  linked and merged into S. Answers what a Retry of `retryAction`/`batch` meets. */
    const mergedRetry = async (rows, lRow, retryAction, batch) => {
      const s2 = await chatter(90);
      const l2 = await chatter(0);
      for (const [action, b] of rows) await pool.query(CANONICAL_ACTION_SQL, [action, s2.c, MOD, null, null, null, b]);
      await log(l2.c, lRow[0], 5, lRow[1] ?? null);
      seq += 1;
      const acct = `@bs5-rt${seq}:site.test`;
      await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [acct]);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($1, 'kick', $4, $5)`,
        [acct, s2.pid, s2.c, l2.pid, l2.c]);
      assert.equal((await quiet(() => identity.mergeCanonicals([s2.c, l2.c]))).survivor, s2.c);
      return standingOf({ action: retryAction, batch_id: batch }, (await newestActions([s2.c], q)).get(s2.c));
    };
    const B1 = '00000000-0000-4000-8000-0000000000b1', U1 = '00000000-0000-4000-8000-0000000000b2', X2 = '00000000-0000-4000-8000-0000000000b3';
    // A carried BAN + an old failed UNBAN batch: refused — a stale unban never lifts a carried ban.
    assert.deepEqual(await mergedRetry([['ban', B1], ['unban', U1]], ['ban'], 'unban', U1), { ok: false, supersededBy: 'ban' },
      'a stale unban Retry would lift the ban a merge carried onto the person');
    // A carried TIMEOUT + a failed BAN batch: allowed — the ban applies.
    assert.deepEqual(await mergedRetry([['ban', X2]], ['timeout', 30], 'ban', X2), { ok: true, durationSeconds: null },
      'a carried timeout refused the Retry of the mod\'s ban');
  });

  // Round 8 — ending a timeout early lifts only the timeout THIS account placed: the identity's own
  // pre-link platform timeout runs out on its own.
  await t.test('ending a site timeout early never lifts a timeout the identity holds of its own', async () => {
    const deps = (m) => ({
      db: { query: (sql, params) => pool.query(sql, params) }, mod: MOD, ceiling: async () => null,
      log: async () => {}, pushChat: async () => {}, fanOut: () => [], fanOutLift: () => [], reconcile: async () => true,
      batchId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
      logError: () => { throw new Error(`timeout failed for ${m}`); },
    });
    const req = (body, method) => new Request('http://x/api/mod/timeout', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const k = await chatter();
    await log(k.c, 'timeout', 1, 60);                 // its own platform timeout, before the link
    const { m, s } = await signUpAndLink(k);
    assert.equal((await timeoutPostResponse(req({ userId: m, minutes: 10, reason: 'spam' }, 'POST'), deps(m))).status, 200);
    const lifted = await timeoutDeleteResponse(req({ userId: m }, 'DELETE'), deps(m));
    assert.equal(lifted.status, 200);
    assert.equal(await judge(s, k.pid), true, 'ending the account\'s timeout lifted the identity\'s own platform timeout');
    const tail = (await rowsOn(s)).slice(-2).map((r) => [r.action, r.reason]);
    assert.deepEqual(tail, [['unban', `timeout ended with ${m}`], ['timeout', `carried by merge from ${k.c}`]], 'not: our timeout lifted, its own placed again');
    // The identity's own timeout then runs out on its own.
    await pool.query(`UPDATE site.mod_log SET expires_at = now() - interval '1 second' WHERE target_id = $1 AND action = 'timeout'`, [s]);
    assert.equal(await judge(s, k.pid), false);
  });

  await t.test('an unban writes nothing onto a canonical with nothing standing', async () => {
    const k = await chatter();
    const { m, s } = await signUpAndLink(k);
    await pool.query(LIFT_BAN_SQL, [m, MOD, '00000000-0000-4000-8000-000000000009']);
    assert.deepEqual(await rowsOn(s), [], 'an unban with nothing to lift wrote a canonical row');
  });

  // The ceiling covers every canonical an account action is written onto: a canonical shared with a
  // moderator's account is refused for a non-admin mod, as an action on that moderator is.
  await t.test('the moderation ceiling reaches the account\'s canonicals', async () => {
    const { checkAccountCanonicalsCeiling } = await import('../web/app/lib/modCeiling.ts');
    const ADMIN = '@bs5-admin:site.test', MOD2 = '@bs5-mod2:site.test', OTHER = '@bs5-othermod:site.test';
    await pool.query(`INSERT INTO site.users (matrix_id, display_name, is_admin, is_mod) VALUES ($1, 'a', true, true), ($2, 'm', false, true), ($3, 'o', false, true)`, [ADMIN, MOD2, OTHER]);
    // A plain person: allowed.
    const k = await chatter();
    const { m } = await signUpAndLink(k);
    assert.equal(await checkAccountCanonicalsCeiling(MOD2, m, q), null);
    // The person's Kick account is linked to a canonical that is ALSO another moderator's own.
    seq += 1;
    const shared = `ab5${String(seq).padStart(9, '0')}`;
    await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [shared]);
    await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2)`, [OTHER, shared]);
    await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', 'bs5-shared', $2)`, [m, shared]);
    const refused = await checkAccountCanonicalsCeiling(MOD2, m, q);
    assert.equal(refused?.status, 403, 'a mod reached another moderator through a shared canonical');
    assert.match(await refused.text(), /only an admin can moderate a moderator/);
    assert.equal(await checkAccountCanonicalsCeiling(ADMIN, m, q), null, 'an admin is refused');
    assert.equal((await checkAccountCanonicalsCeiling(MOD2, m, async () => { throw new Error('db down'); })).status, 503, 'a failed read did not fail closed');
  });
});
