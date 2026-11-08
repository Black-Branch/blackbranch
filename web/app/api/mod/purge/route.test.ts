// Purge by a LINKED canonical (the ⋯ menu on a platform line names its sender by canonical) used to
// flag native rows `WHERE matrix_id = <the canonical>` — nothing — so the Twitch lines went and the
// same person's site lines from the same window stayed up for everyone (A3-03). The purge now
// expands a canonical into its site accounts exactly like the ban route (canonicalIdentity.ts
// siteAccountsOf — one helper, both callers) and flags each account's site lines.
//   • against a real Postgres: the lines a purge by canonical / by matrix id / of a platform-only
//     chatter flags (app/lib/modPurge.ts purgeLines, which runPurge runs, after siteAccountsOf);
//   • a scan: the route and the ban route both expand through siteAccountsOf.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/api/mod/purge/route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { purgeLines } from "../../../lib/modPurge.ts";
import { siteAccountsOf } from "../../../lib/canonicalIdentity.ts";
import { checkAccountCanonicalsCeiling, checkModerationCeiling } from "../../../lib/modCeiling.ts";
import { stripComments } from "../../../lib/testSource.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `prg${process.pid}x${Date.now().toString(36)}`;
const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");

test("purge by a linked canonical removes that account's site lines too", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const CASEY = `@${RUN}-casey:site.test`, ALT = `@${RUN}-alt:site.test`, DANA = `@${RUN}-dana:site.test`;
  const people = [CASEY, ALT, DANA];
  const [cTwitch, cNative, cLoner, cDana] = [hex(1), hex(2), hex(3), hex(4)];
  const canon = [cTwitch, cNative, cLoner, cDana];
  const clean = async () => {
    await pool.query(`DELETE FROM site.chat_messages WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [people]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  for (const m of people) await pool.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'x')`, [m]);
  for (const c of canon) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x')`, [c]);
  // casey: a linked Twitch identity and her own native identity. Her second account ALT chats on the
  // site under that same Twitch identity (its native link points at it): one person, two accounts.
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('twitch', $1, $2), ('native', $3, $4), ('native', $5, $2), ('kick', $6, $7), ('twitch', $8, $9)`,
    [`${RUN}-tw`, cTwitch, CASEY, cNative, ALT, `${RUN}-loner`, cLoner, `${RUN}-dana`, cDana]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($4, 'twitch', $5, $6)`,
    [CASEY, `${RUN}-tw`, cTwitch, DANA, `${RUN}-dana`, cDana]);
  const site = async (who: string, minsAgo = 1) => Number((await pool.query(
    `INSERT INTO site.chat_messages (matrix_id, message, created_at) VALUES ($1, 'hi', now() - make_interval(mins => $2)) RETURNING id`, [who, minsAgo])).rows[0].id);
  const plat = async (c: string, platform: string) => Number((await pool.query(
    `INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, $2, 'x', 'hi') RETURNING id`, [c, platform])).rows[0].id);
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  const deleted = async (ids: number[]) => (await pool.query(`SELECT id FROM site.chat_messages WHERE id = ANY($1) AND is_deleted`, [ids])).rows.map((r) => Number(r.id)).sort();

  const caseySite = await site(CASEY), altSite = await site(ALT), caseyOld = await site(CASEY, 600), danaSite = await site(DANA);
  const caseyTwitch = await plat(cTwitch, "twitch"), lonerKick = await plat(cLoner, "kick");

  await t.test("by the linked Twitch canonical: every linked account's site lines in the window, and the Twitch lines", async () => {
    const accounts = await siteAccountsOf(cTwitch, q);
    assert.deepEqual(accounts, [ALT, CASEY].sort(), "the canonical was not expanded to both accounts");
    const out = await purgeLines(cTwitch, accounts, 60, 250, q);
    assert.deepEqual(out.native.map(Number).sort(), [caseySite, altSite].sort(), "a linked account's site lines stayed up");
    assert.deepEqual(await deleted([caseySite, altSite, caseyOld, danaSite]), [caseySite, altSite].sort());
    assert.ok(out.platform.some((r) => Number(r.id) === caseyTwitch), "the Twitch line was not found");
    assert.ok(!out.platform.some((r) => Number(r.id) === lonerKick), "someone else's line was found");
  });

  await t.test("a retry finds nothing left to flag; by matrix id still reaches the account's own lines", async () => {
    const again = await purgeLines(cTwitch, await siteAccountsOf(cTwitch, q), 60, 250, q);
    assert.deepEqual(again.native, [], "a second purge flagged rows again");
    const fresh = await site(CASEY);
    const byId = await purgeLines(CASEY, await siteAccountsOf(CASEY, q), 60, 250, q);
    assert.deepEqual(byId.native.map(Number), [fresh]);
    assert.ok(byId.platform.some((r) => Number(r.id) === caseyTwitch), "by matrix id, the linked Twitch line was not found");
  });

  await t.test("a platform-only chatter: no site account, their own lines only", async () => {
    assert.deepEqual(await siteAccountsOf(cLoner, q), []);
    const out = await purgeLines(cLoner, [], 60, 250, q);
    assert.deepEqual(out.native, []);
    assert.deepEqual(out.platform.map((r) => Number(r.id)), [lonerKick]);
    assert.deepEqual(await deleted([danaSite]), [], "another person's site line was flagged");
  });

  await t.test("a failed identity read throws (the route answers 503), never a narrower purge", async () => {
    await assert.rejects(siteAccountsOf(cTwitch, async () => { throw new Error("db down"); }), /db down/);
  });
});

test("both the purge and the ban route expand a canonical through the one helper", () => {
  const read = (p: string) => {
    const raw = readFileSync(join(import.meta.dirname, p), "utf8");
    assert.match(raw, /\}\n?$/, `${p}: END not read`);
    return stripComments(raw);
  };
  const purge = read("route.ts");
  assert.match(purge, /accounts = await siteAccountsOf\(targetId, /);
  assert.match(purge, /await runPurge\(purgeDeps\(mod, targetId\), \{ targetId, accounts, windowMinutes, batchId \}\);/);
  const ban = read("../ban/route.ts");
  assert.match(ban, /siteAccountsOf\(canonicalId, /);
});

// A purge reaches every identity of every account the target expands to (purgeLines). A canonical
// shared with a MODERATOR's account (their own native canonical, linked by the target's account too)
// let a non-admin mod purge that moderator's lines: the route now runs assertCanModerateAccount (the
// account, then every canonical linked to it — modCeiling.ts) over every account, before any write.
test("a mod purging a person whose account shares a canonical with a moderator is refused before any write", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  const MOD = `@${RUN}-mod:site.test`, OTHER = `@${RUN}-othermod:site.test`, PERSON = `@${RUN}-person:site.test`;
  const people = [MOD, OTHER, PERSON];
  const [cTwitch, cShared] = [hex(11), hex(12)];
  const clean = async () => {
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [[cTwitch, cShared]]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [[cTwitch, cShared]]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [people]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  await pool.query(`INSERT INTO site.users (matrix_id, display_name, is_mod) VALUES ($1, 'm', true), ($2, 'o', true), ($3, 'p', false)`, people);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'x'), ($2, 'x')`, [cTwitch, cShared]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2)`, [OTHER, cShared]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($1, 'kick', $4, $5)`,
    [PERSON, `${RUN}-t`, cTwitch, `${RUN}-k`, cShared]);
  // The route's steps, on the real tables: the target ceiling, the expansion, then every account.
  assert.equal(await checkModerationCeiling(MOD, cTwitch, q as never), null, "precondition: the target itself passes");
  const accounts = await siteAccountsOf(cTwitch, q as never);
  assert.deepEqual(accounts, [PERSON]);
  const refusals = [];
  for (const account of accounts) {
    const refused = (await checkModerationCeiling(MOD, account, q as never)) ?? (await checkAccountCanonicalsCeiling(MOD, account, q as never));
    if (refused) refusals.push(refused.status);
  }
  assert.deepEqual(refusals, [403], "a mod reached another moderator's lines through a shared canonical");
  // A failed read fails closed.
  const down = async () => { throw new Error("db down"); };
  assert.equal((await checkAccountCanonicalsCeiling(MOD, PERSON, down as never))?.status, 503);

  // The route runs it over every account after the expansion and before purgeLines (the first write).
  const route = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
  const expand = route.indexOf("accounts = await siteAccountsOf(targetId, ");
  const guard = route.indexOf("for (const account of accounts) {\n    const refused = await assertCanModerateAccount(mod, account);\n    if (refused) return refused;");
  const write = route.indexOf("await runPurge(purgeDeps(mod, targetId), { targetId, accounts, ");
  assert.ok(expand > 0 && guard > expand && write > guard, "the account ceiling is not between the expansion and the first write");
  assert.match(route.trimEnd(), /return Response\.json\(\{ ok: true, batchId, purged \}\);\n\}$/, "vacuity: the scan reached the end of the route");
});
