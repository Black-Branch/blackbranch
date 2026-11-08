// A permanent ban placed above your rank needs that rank to lift or change (KG-16): a permanent ban
// takes a mod's role away, so the ceiling (the target's role NOW) let any mod lift the ban that
// removed a mod. modUnban.ts reads who PLACED the ban.
//   • the rank comparison (liftDenied) and the refusal's words, with a stand-in query;
//   • against a real Postgres: the placer read from site.bans, a retry, and a restart (a fresh pool);
//   • a scan: the ban route asks before the lift SQL (DELETE) and before any ban is written (POST).
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/modUnban.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { liftDenied, banLiftRefusal, type LiftQuery } from "./modUnban.ts";
import { roleRank } from "./modCeiling.ts";
import { stripComments } from "./testSource.ts";

const { at } = createRequire(import.meta.url)("../../../stream-api/testlib/source.js") as { at: (hay: string, needle: string) => number };

const ADMIN = roleRank({ is_admin: true }), STAFF = roleRank({ is_staff: true }), MOD = roleRank({ is_mod: true });

test("the ladder: admin above Staff above mod above everyone", () => {
  assert.deepEqual([ADMIN, STAFF, MOD, roleRank({}), roleRank(null)], [100, 75, 50, 0, 0]);
  assert.equal(roleRank({ is_mod: true, is_staff: true }), 75, "the highest role counts");
});

test("mod vs admin's ban → denied", () => {
  assert.equal(liftDenied({ bannerRank: ADMIN, actorRank: MOD }), true);
});
test("admin → allowed", () => {
  assert.equal(liftDenied({ bannerRank: ADMIN, actorRank: ADMIN }), false);
  assert.equal(liftDenied({ bannerRank: MOD, actorRank: ADMIN }), false);
});
test("mod vs mod's ban → allowed", () => {
  assert.equal(liftDenied({ bannerRank: MOD, actorRank: MOD }), false);
});
test("mod vs Staff's ban → denied (KG-16's former mod/Staff)", () => {
  assert.equal(liftDenied({ bannerRank: STAFF, actorRank: MOD }), true);
  assert.equal(liftDenied({ bannerRank: STAFF, actorRank: STAFF }), false);
});

// A stand-in database: the placer SQL answers `placers`, the roles SQL answers `roles`.
const fake = (placers: string[], roles: Record<string, object>): LiftQuery => async (sql, params) =>
  /FROM site\.users WHERE matrix_id = ANY/.test(sql)
    ? { rows: (params[0] as string[]).filter((id) => roles[id]).map((id) => ({ matrix_id: id, ...roles[id] })) }
    : { rows: /FROM site\.bans/.test(sql) ? placers.map((placer) => ({ placer })) : [] };
const lift = (accounts: string[]) => ({ kind: "lift" as const, accounts });

test("the refusal names the rank that placed the ban; a failed read refuses (503); no ban = no refusal", async () => {
  const roles = { "@a:x": { is_admin: true }, "@s:x": { is_staff: true }, "@m:x": { is_mod: true }, "@m2:x": { is_mod: true } };
  const admins = await banLiftRefusal("@m:x", lift(["@t:x"]), fake(["@a:x"], roles));
  assert.equal(admins?.status, 403);
  assert.equal(await admins?.text(), "An admin placed this ban — only an admin can lift or change it.");
  const staffs = await banLiftRefusal("@m:x", lift(["@t:x"]), fake(["@s:x"], roles));
  assert.equal(await staffs?.text(), "A member of staff placed this ban — only staff or an admin can lift or change it.");
  assert.equal(await banLiftRefusal("@m:x", lift(["@t:x"]), fake(["@m2:x"], roles)), null);
  assert.equal(await banLiftRefusal("@a:x", lift(["@t:x"]), fake(["@a:x"], roles)), null);
  assert.equal(await banLiftRefusal("@m:x", lift(["@t:x"]), fake([], roles)), null);
  assert.equal(await banLiftRefusal("@m:x", lift(["@t:x"]), fake(["blackbranch"], roles)), null, "a placer with no account ranks nobody");
  const down = await banLiftRefusal("@m:x", lift(["@t:x"]), async () => { throw new Error("down"); });
  assert.equal(down?.status, 503);
  let asked = false;
  assert.equal(await banLiftRefusal("@m:x", lift([]), async () => { asked = true; return { rows: [] }; }), null);
  assert.equal(asked, false, "nothing to lift, no read");
});

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `mub${process.pid}x${Date.now().toString(36)}`;

test("real Postgres: every ban the lift removes is read — the account's and its canonicals'; retry and restart answer the same", { skip }, async (t) => {
  const OWNER = `@${RUN}-owner:site.test`, MOD1 = `@${RUN}-m1:site.test`, MOD2 = `@${RUN}-m2:site.test`;
  const EXMOD = `@${RUN}-ex:site.test`, USER = `@${RUN}-u:site.test`, VIEWER = `@${RUN}-v:site.test`;
  const people = [OWNER, MOD1, MOD2, EXMOD, USER, VIEWER];
  const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");
  const [CANON, LONER] = [hex(1), hex(2)];
  let pool = new Pool({ connectionString: DB_URL, max: 2 });
  const clean = async (p: Pool) => {
    await p.query(`DELETE FROM site.bans WHERE matrix_id = ANY($1)`, [people]);
    await p.query(`DELETE FROM site.mod_log WHERE target_id = ANY($1)`, [[CANON, LONER]]);
    await p.query(`DELETE FROM site.platform_links WHERE matrix_id = ANY($1)`, [people]);
    await p.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [[CANON, LONER]]);
    await p.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [people]);
  };
  await clean(pool);
  t.after(async () => { await clean(pool); await pool.end(); });
  await pool.query(`INSERT INTO site.users (matrix_id, is_admin, is_mod) VALUES ($1, true, true), ($2, false, true), ($3, false, true), ($4, false, false), ($5, false, false), ($6, false, false)`,
    [OWNER, MOD1, MOD2, EXMOD, USER, VIEWER]);
  // The owner's permanent ban of a former mod (the ban took the role); a mod's of a viewer.
  await pool.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, NULL), ($3, $4, NULL)`, [EXMOD, OWNER, USER, MOD2]);
  const query = (p: Pool): LiftQuery => (sql, params) => p.query(sql, params);

  const refused = await banLiftRefusal(MOD1, lift([EXMOD]), query(pool));
  assert.equal(refused?.status, 403, "a mod cannot lift the owner's ban of a former mod");
  assert.equal(await banLiftRefusal(OWNER, lift([EXMOD]), query(pool)), null, "the owner can");
  assert.equal(await banLiftRefusal(MOD1, lift([USER]), query(pool)), null, "a mod lifts another mod's ban");
  assert.equal((await banLiftRefusal(MOD1, lift([USER, EXMOD]), query(pool)))?.status, 403, "one ban above you among the accounts refuses");

  // retry: the refusal wrote nothing, and the same request is refused again.
  assert.equal((await banLiftRefusal(MOD1, lift([EXMOD]), query(pool)))?.status, 403);
  assert.equal((await pool.query(`SELECT 1 FROM site.bans WHERE matrix_id = $1 AND expires_at IS NULL`, [EXMOD])).rows.length, 1);

  // A timeout is not covered (it ends on its own).
  await pool.query(`UPDATE site.bans SET expires_at = now() + interval '1 hour' WHERE matrix_id = $1`, [EXMOD]);
  assert.equal(await banLiftRefusal(MOD1, lift([EXMOD]), query(pool)), null);
  await pool.query(`UPDATE site.bans SET expires_at = NULL WHERE matrix_id = $1`, [EXMOD]);
  // The placer's rank NOW: an admin who is no longer one no longer outranks the mod.
  await pool.query(`UPDATE site.users SET is_admin = false WHERE matrix_id = $1`, [OWNER]);
  assert.equal(await banLiftRefusal(MOD1, lift([EXMOD]), query(pool)), null);
  await pool.query(`UPDATE site.users SET is_admin = true WHERE matrix_id = $1`, [OWNER]);

  // Everything the lift removes counts. LIFT_BAN_SQL also unbans every standing canonical linked to
  // the account: a viewer whose platform identity the owner banned (before the link, so no site
  // ban) is not a mod's to lift, though the account itself holds nothing.
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, $1), ($2, $2)`, [CANON, LONER]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3)`, [VIEWER, `${RUN}-tw`, CANON]);
  await pool.query(`INSERT INTO site.mod_log (action, target_id, performed_by) VALUES ('ban', $1, $2), ('ban', $3, $2)`, [CANON, OWNER, LONER]);
  assert.equal((await banLiftRefusal(MOD1, lift([VIEWER]), query(pool)))?.status, 403, "a linked canonical's ban placed above refuses the Unban");
  assert.equal(await banLiftRefusal(MOD1, { kind: "replace", accounts: [VIEWER] }, query(pool)), null,
    "a new ban never lifts a canonical's own ban, so banning that viewer stays a mod's call");
  assert.equal(await banLiftRefusal(OWNER, lift([VIEWER]), query(pool)), null);
  // An unlinked chatter's own standing ban, by canonical.
  const loner = { kind: "lift" as const, accounts: [], canonicals: [LONER] };
  assert.equal((await banLiftRefusal(MOD1, loner, query(pool)))?.status, 403, "an unlinked chatter the owner banned");
  // Once lifted (a later 'unban' row), the ban no longer stands and nothing refuses.
  await pool.query(`INSERT INTO site.mod_log (action, target_id, performed_by) VALUES ('unban', $1, $2), ('unban', $3, $2)`, [CANON, OWNER, LONER]);
  assert.equal(await banLiftRefusal(MOD1, lift([VIEWER]), query(pool)), null);
  assert.equal(await banLiftRefusal(MOD1, loner, query(pool)), null);
  // A mod's ban of the canonical is any mod's to lift.
  await pool.query(`INSERT INTO site.mod_log (action, target_id, performed_by) VALUES ('ban', $1, $2)`, [LONER, MOD2]);
  assert.equal(await banLiftRefusal(MOD1, loner, query(pool)), null);

  // restart: a fresh pool (a restarted server) keeps nothing in memory and answers the same.
  await pool.end();
  pool = new Pool({ connectionString: DB_URL, max: 2 });
  assert.equal((await banLiftRefusal(MOD1, lift([EXMOD]), query(pool)))?.status, 403);
});

const ROUTE = stripComments(readFileSync(join(process.cwd(), "app/api/mod/ban/route.ts"), "utf8"));

test("the ban route: DELETE asks after the ceiling and before the lift SQL", () => {
  const del = ROUTE.slice(at(ROUTE, "export async function DELETE"));
  const ceiling = at(del, "assertCanModerateAccount(mod, account)");
  const ask = at(del, `banLiftRefusal(mod, { kind: "lift", accounts: targets }`);
  const lifted = at(del, "pool.query(LIFT_BAN_SQL");
  assert.ok(ceiling < ask && ask < lifted, "the placer's rank is checked before the ban is lifted");
  const loner = at(del, `banLiftRefusal(mod, { kind: "lift", accounts: [], canonicals: [canonicalId] }`);
  assert.ok(loner < at(del, `CANONICAL_ACTION_SQL, ["unban"`), "an unlinked chatter's ban too, before its unban row");
});

test("the ban route: POST asks before a ban is written over a permanent one", () => {
  const post = ROUTE.slice(at(ROUTE, "export async function POST"), at(ROUTE, "export async function DELETE"));
  const ask = at(post, `banLiftRefusal(mod, { kind: "replace", accounts: targets }`);
  assert.ok(ask < at(post, "results.push(await banAccount("), "a mod cannot rewrite (then lift) an admin's ban");
  assert.ok(at(post, "assertCanModerateAccount(mod, account)") < ask);
});

test("vacuity anchor: the route scan read to the end of the file", () => {
  assert.match(ROUTE, /return Response\.json\(\{ ok: true, batchId, platforms: \[\.\.\.platforms\] \}\);\s*\}\s*$/);
});
