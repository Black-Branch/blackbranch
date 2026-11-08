// A ban or timeout also removes the person's recent lines (ticket #228): banning from an OLDER line
// used to remove that one line only, and everything they said after it stayed up on the site. The
// ban route now runs the Purge button's own purge (app/lib/modPurge.ts runPurge — one helper, both
// routes) unless the mod turned the switch off; an unban removes nothing.
//   • against a real Postgres: what a ban's purge flags, sends and logs (runPurge, as the ban
//     route calls it), a retry, and a restart (a fresh pool);
//   • the switch's reading of a body (banPurges);
//   • a scan: where the ban route calls it — after every ceiling check, in both branches, never
//     in the unban.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/api/mod/ban/route.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { runPurge, purgeWithBan, type PurgeDeps } from "../../../lib/modPurge.ts";
import { banPurges, clickedLineOf, PURGE_MAX_MINUTES } from "../../../lib/modRequests.ts";
import { siteAccountsOf } from "../../../lib/canonicalIdentity.ts";
import { stripComments } from "../../../lib/testSource.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `ban${process.pid}x${Date.now().toString(36)}`;
const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");

type Sent = { items: { platform: string; id: number }[]; batchId: string };
type Logged = { reason: string; batchId: string };
type Fanned = { kick: string[]; youtube: string[]; twitch: boolean };

/** The route's side effects, recorded: the one WS purge frame, the mod-log rows, the platform fan-out.
 *  The frame's stand-in flags the platform lines as stream-api's /chat/purge does. */
function recorder(pool: Pool) {
  const sent: Sent[] = [], logged: Logged[] = [], fanned: Fanned[] = [];
  const deps: PurgeDeps = {
    query: (sql, params) => pool.query(sql, params),
    broadcast: async (items, batchId) => {
      sent.push({ items, batchId });
      await pool.query(`UPDATE stream.chat_log SET is_deleted = true WHERE id = ANY($1::bigint[])`,
        [items.filter((i) => i.platform !== "native").map((i) => i.id)]);
    },
    copies: async () => new Map(),
    log: async (reason, batchId) => { logged.push({ reason, batchId }); },
    fanOut: (kick, youtube, _batchId, opts) => { fanned.push({ kick, youtube, twitch: opts.twitch }); },
  };
  return { deps, sent, logged, fanned };
}

test("a purge that throws after the ban went out never turns the ban into a failure", async () => {
  // The ban row, the chat push and the reconcile are already out when the purge runs: a throw there
  // used to answer 500, and the mod read "Ban failed" with no Undo for a ban that stood.
  const warned: unknown[] = [];
  const logged: string[] = [];
  const throwing: PurgeDeps = {
    query: async () => { throw new Error("db blip"); },
    broadcast: async () => {}, copies: async () => new Map(),
    log: async (reason) => { logged.push(reason); }, fanOut: () => {},
  };
  const run = { targetId: "@a:site.test", accounts: ["@a:site.test"], windowMinutes: PURGE_MAX_MINUTES, batchId: "b", alongside: "ban" as const };
  assert.deepEqual(await purgeWithBan(throwing, run, (...a) => { warned.push(a); }), { purged: null, purgeFailed: true });
  assert.equal(warned.length, 1, "the purge's failure was not logged on the server");
  // Its mod-log write failing after the lines were flagged is the same answer.
  const lateThrow: PurgeDeps = { ...throwing, query: async () => ({ rows: [] }), log: async () => { throw new Error("log down"); } };
  assert.deepEqual(await purgeWithBan(lateThrow, run, () => {}), { purged: null, purgeFailed: true });
  // And a purge that works answers as before.
  const fine: PurgeDeps = { ...throwing, query: async () => ({ rows: [] }) };
  assert.deepEqual(await purgeWithBan(fine, run, () => {}), { purged: 0, purgeFailed: false });

  // The route: both branches purge through purgeWithBan, after the ban's own write, and answer the
  // ban's normal success with the purge's outcome; no bare runPurge is awaited there.
  const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
  const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function DELETE"));
  assert.doesNotMatch(post, /await runPurge\(/, "a purge failure can still fail the ban");
  const at = [...post.matchAll(/purge \? await purgeWithBan\(/g)].map((m) => m.index!);
  assert.equal(at.length, 2);
  assert.ok(at[0]! > post.indexOf("await pool.query(CANONICAL_ACTION_SQL"), "the platform-only purge runs before its ban row");
  assert.ok(at[1]! > post.indexOf("results.push(await banAccount("), "the account purge runs before the bans");
  assert.equal((post.match(/applied: true, [^\n]*purged, purgeFailed, clickedSkipped: clicked === "invalid" \}\);/g) ?? []).length, 2,
    "a branch does not answer the purge's outcome with the ban's success");
});

test("the ban switch: on unless the mod turned it off", () => {
  assert.equal(banPurges({ targetId: "@a:site.test" }), true, "a ban with no word about it purges");
  assert.equal(banPurges({ targetId: "@a:site.test", purge: true }), true);
  assert.equal(banPurges({ targetId: "@a:site.test", purge: false }), false, "the switch turned off");
  assert.equal(banPurges(null), true);
});

test("a clicked line that cannot be purged never blocks the ban; an out-of-range id is skipped, and said", () => {
  // Postgres bigint ends at 9223372036854775807: a longer id would throw inside the purge. It never
  // reaches SQL; the ban and the window's purge go ahead and the one mod-log row says it was skipped.
  assert.equal(clickedLineOf({ message: { id: "99999999999999999999", platform: "native" } }), "invalid");
  assert.equal(clickedLineOf({ message: { id: "9223372036854775808", platform: "youtube" } }), "invalid");
  assert.deepEqual(clickedLineOf({ message: { id: "9223372036854775807", platform: "native" } }), { id: "9223372036854775807", platform: "native" });
  assert.deepEqual(clickedLineOf({ message: { id: 42, platform: "kick" } }), { id: "42", platform: "kick" });
  // The held-queue card's synthetic ids, a negative or missing id, no platform: no clicked line (as before).
  assert.equal(clickedLineOf({ message: { id: "automod:17", platform: "twitch" } }), null);
  assert.equal(clickedLineOf({ message: { id: "-1", platform: "native" } }), null);
  assert.equal(clickedLineOf({ message: { id: 7 } }), null);
  assert.equal(clickedLineOf({ targetId: "@a:site.test" }), null);
  // The route never refuses the ban over it: no early answer on the clicked line, and it reaches the purge.
  const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));
  const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function DELETE"));
  assert.doesNotMatch(post, /clicked[^\n]*return new Response/, "a clicked line can refuse the ban");
  assert.match(post, /const clicked = clickedLineOf\(body\);/);
  assert.equal((post.match(/clickedSkipped: clicked === "invalid"/g) ?? []).length, 4, "a branch's purge or answer does not say the clicked line was skipped");
  assert.match(post.trimEnd(), /identitiesKeepBan, purged, purgeFailed, clickedSkipped: clicked === "invalid" \}\);\n\}$/, "vacuity: the POST was read to its end");
});

test("a ban removes every recent line of the person, in one frame and one mod-log row", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const CASEY = `@${RUN}-casey:site.test`, DANA = `@${RUN}-dana:site.test`;
  const people = [CASEY, DANA];
  const [cYt, cKick, cLoner] = [hex(1), hex(2), hex(3)];
  const canon = [cYt, cKick, cLoner];
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
  // casey chats on the site and, linked, on YouTube; a platform-only Kick chatter beside her.
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('youtube', $1, $2), ('kick', $3, $4)`,
    [`${RUN}-yt`, cYt, `${RUN}-loner`, cLoner]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'youtube', $2, $3)`,
    [CASEY, `${RUN}-yt`, cYt]);
  const site = async (who: string, minsAgo: number) => Number((await pool.query(
    `INSERT INTO site.chat_messages (matrix_id, message, created_at) VALUES ($1, 'hi', now() - make_interval(secs => $2::float8 * 60)) RETURNING id`, [who, minsAgo])).rows[0].id);
  const plat = async (c: string, platform: string, msgId: string, minsAgo: number) => Number((await pool.query(
    `INSERT INTO stream.chat_log (user_id, platform, username, message, platform_msg_id, created_at)
     VALUES ($1, $2, 'x', 'hi', $3, now() - make_interval(secs => $4::float8 * 60)) RETURNING id`, [c, platform, msgId, minsAgo])).rows[0].id);
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);

  // Five lines over two minutes: three on the site, two on YouTube (reader-captured ids, not "LCC.").
  const caseySite = [await site(CASEY, 2), await site(CASEY, 1.5), await site(CASEY, 0.5)];
  const caseyYt = [await plat(cYt, "youtube", `Chw${RUN}a`, 1.8), await plat(cYt, "youtube", `Chw${RUN}b`, 1)];
  const caseyOld = await site(CASEY, 25 * 60);
  const danaSite = await site(DANA, 1);
  const lonerKick = await plat(cLoner, "kick", `${RUN}-k1`, 1);
  const deletedSite = async (ids: number[]) => (await pool.query(
    `SELECT id FROM site.chat_messages WHERE id = ANY($1) AND is_deleted`, [ids])).rows.map((r) => Number(r.id)).sort();

  await t.test("a ban: every line of hers in the window goes, in ONE frame and ONE mod-log row with both facts", async () => {
    const r = recorder(pool);
    const accounts = await siteAccountsOf(CASEY, q);
    const out = await runPurge(r.deps, { targetId: CASEY, accounts, windowMinutes: PURGE_MAX_MINUTES, batchId: "b-1", alongside: "ban" });
    assert.equal(out.purged, 5, "not every line of hers was removed");
    assert.deepEqual(await deletedSite([...caseySite, caseyOld, danaSite]), [...caseySite].sort(), "the wrong site lines were flagged");
    assert.equal(r.sent.length, 1, "more than one purge frame");
    assert.deepEqual(r.sent[0]!.items.map((i) => `${i.platform}:${i.id}`).sort(),
      [...caseySite.map((id) => `native:${id}`), ...caseyYt.map((id) => `youtube:${id}`)].sort());
    assert.equal(r.sent[0]!.batchId, "b-1", "the frame is not the ban's batch");
    assert.deepEqual(r.logged, [{ reason: "ban + purge 5 lines / last 24h", batchId: "b-1" }]);
    // The Twitch ban clears their Twitch chat itself; a 1-second timeout after it would only
    // replace a longer timeout there.
    assert.deepEqual(r.fanned, [{ kick: [], youtube: [`Chw${RUN}a`, `Chw${RUN}b`].sort().reverse(), twitch: false }]);
  });

  await t.test("retry: banning again finds nothing left to remove, and says so in its one row", async () => {
    const r = recorder(pool);
    const out = await runPurge(r.deps, { targetId: CASEY, accounts: [CASEY], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-2", alongside: "ban" });
    assert.equal(out.purged, 0, "a second ban flagged lines again");
    assert.deepEqual(r.sent, [], "an empty purge frame was sent");
    assert.deepEqual(r.logged, [{ reason: "ban + purge 0 lines / last 24h", batchId: "b-2" }]);
  });

  await t.test("restart: the removal lives in the database — a fresh process reads every line as removed", async () => {
    const fresh = new Pool({ connectionString: DB_URL, max: 1 });
    try {
      const { rows: s } = await fresh.query(`SELECT count(*)::int AS n FROM site.chat_messages WHERE id = ANY($1) AND NOT is_deleted`, [caseySite]);
      assert.equal(s[0].n, 0, "a site line came back after a restart");
      const again = await runPurge(recorder(fresh).deps, { targetId: CASEY, accounts: [CASEY], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-3", alongside: "ban" });
      assert.equal(again.purged, 0, "a line came back after a restart");
      const { rows: p } = await fresh.query(`SELECT count(*)::int AS n FROM stream.chat_log WHERE id = ANY($1) AND NOT is_deleted`, [caseyYt]);
      assert.equal(p[0].n, 0, "a YouTube line came back after a restart");
    } finally { await fresh.end(); }
  });

  await t.test("a timeout purges like a ban; a platform-only chatter is purged by their canonical", async () => {
    const r = recorder(pool);
    const out = await runPurge(r.deps, { targetId: cLoner, accounts: [], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-4", alongside: "timeout" });
    assert.equal(out.purged, 1);
    assert.deepEqual(r.sent[0]!.items, [{ platform: "kick", id: lonerKick }]);
    assert.deepEqual(r.logged, [{ reason: "timeout + purge 1 lines / last 24h", batchId: "b-4" }]);
    assert.deepEqual(r.fanned, [{ kick: [`${RUN}-k1`], youtube: [], twitch: false }]);
    assert.deepEqual(await deletedSite([danaSite]), [], "someone else's line went");
  });

  await t.test("the Purge button's own purge is unchanged: Twitch is cleared, the row reads as before", async () => {
    const extra = await site(DANA, 1);
    const r = recorder(pool);
    const out = await runPurge(r.deps, { targetId: DANA, accounts: [DANA], windowMinutes: 60, batchId: "b-5" });
    assert.equal(out.purged, 2);
    assert.deepEqual(await deletedSite([danaSite, extra]), [danaSite, extra].sort());
    assert.deepEqual(r.logged, [{ reason: "2 messages / last 1h", batchId: "b-5" }]);
    assert.equal(r.fanned[0]!.twitch, true);
  });

  await t.test("ban on a line older than the window still removes that line — and only if it is theirs", async () => {
    const oldSite = await site(DANA, 30 * 60);
    const oldYt = await plat(cYt, "youtube", `Chw${RUN}old`, 30 * 60);
    const r = recorder(pool);
    // (Her recent lines are gone already.) The clicked line is a site line 30 hours old: outside the 24-hour window, removed by its id.
    const out = await runPurge(r.deps, { targetId: DANA, accounts: [DANA], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-6", alongside: "ban",
      clicked: { platform: "native", id: String(oldSite) } });
    assert.equal(out.purged, 1, "the clicked old line was not removed");
    assert.deepEqual(await deletedSite([oldSite]), [oldSite]);
    assert.ok(r.sent[0]!.items.some((i) => i.platform === "native" && i.id === oldSite), "the clicked line is not in the purge frame");
    assert.deepEqual(r.logged, [{ reason: "ban + purge 1 lines / last 24h", batchId: "b-6" }], "the clicked line got a mod-log story of its own");
    // A platform line, old, clicked: in the frame and in the YouTube fan-out by its id.
    const r2 = recorder(pool);
    const out2 = await runPurge(r2.deps, { targetId: CASEY, accounts: [CASEY], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-7", alongside: "ban",
      clicked: { platform: "youtube", id: String(oldYt) } });
    assert.equal(out2.purged, 1);
    assert.deepEqual(r2.sent[0]!.items, [{ platform: "youtube", id: oldYt }]);
    assert.deepEqual(r2.fanned[0]!.youtube, [`Chw${RUN}old`]);
    // Someone else's line named as the clicked one is never touched (the ceiling covered the target only).
    const others = await site(CASEY, 30 * 60);
    const r3 = recorder(pool);
    const out3 = await runPurge(r3.deps, { targetId: DANA, accounts: [DANA], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-8", alongside: "ban",
      clicked: { platform: "native", id: String(others) } });
    assert.equal(out3.purged, 0);
    assert.deepEqual(await deletedSite([others]), [], "a line of someone else's was removed through a ban");
    // An id past the bigint range never reaches Postgres; the purge still runs and its one row says so.
    const fresh = await site(DANA, 1);
    const r5 = recorder(pool);
    const out5 = await runPurge(r5.deps, { targetId: DANA, accounts: [DANA], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-10", alongside: "ban",
      clicked: { platform: "native", id: "99999999999999999999" }, clickedSkipped: true });
    assert.equal(out5.purged, 1, "the window's purge did not run");
    assert.deepEqual(await deletedSite([fresh]), [fresh]);
    assert.deepEqual(r5.logged, [{ reason: "ban + purge 1 lines / last 24h · clicked line skipped", batchId: "b-10" }], "the skip is not in the one mod-log row");
    const r4 = recorder(pool);
    assert.equal((await runPurge(r4.deps, { targetId: DANA, accounts: [DANA], windowMinutes: PURGE_MAX_MINUTES, batchId: "b-9", alongside: "ban",
      clicked: { platform: "youtube", id: String(lonerKick) } })).purged, 0, "another person's platform line was removed");
  });
});

test("the ban route purges after every ceiling check, in both branches, and the unban never does", () => {
  const read = (p: string) => {
    const raw = readFileSync(join(import.meta.dirname, p), "utf8");
    assert.match(raw, /\}\n?$/, `${p}: END not read`);
    return stripComments(raw);
  };
  const ban = read("route.ts");
  const post = ban.slice(ban.indexOf("export async function POST"), ban.indexOf("export async function DELETE"));
  const unban = ban.slice(ban.indexOf("export async function DELETE"));
  assert.ok(post.length > 0 && unban.length > 0, "vacuity: the verbs were not found");
  assert.match(post, /const purge = banPurges\(body\);/);
  assert.match(post, /const clicked = clickedLineOf\(body\);/);
  const calls = [...post.matchAll(/const \{ purged, purgeFailed \} = purge \? await purgeWithBan\(purgeDeps\(mod, (\w+)\), \{ targetId: \1, accounts: (\w+), windowMinutes: PURGE_MAX_MINUTES, batchId, alongside, clicked: clicked === "invalid" \? null : clicked, clickedSkipped: clicked === "invalid" \}\)/g)];
  assert.deepEqual(calls.map((m) => `${m[1]}/${m[2]}`), ["canonicalId/noAccounts", "purgeTarget/targets"], "a branch does not purge, or purges someone else");
  // The platform-only branch: after the target's ceiling. The account branch: after every account's.
  const targetGuard = post.indexOf("const denied = await assertCanModerate(mod, guardTarget);");
  const accountGuard = post.indexOf("for (const account of targets) {\n    const denied = await assertCanModerateAccount(mod, account);\n    if (denied) return denied;\n  }");
  assert.ok(targetGuard > 0 && accountGuard > targetGuard, "the ceiling checks were not found");
  assert.ok(calls[0]!.index! > targetGuard, "the platform-only purge runs before the ceiling");
  assert.ok(calls[1]!.index! > accountGuard, "the account purge runs before every account's ceiling");
  // Only an applied ban purges: the kept-stronger-ban answer returns first.
  assert.ok(post.indexOf("if (!results.some((r) => r.applied)) return") < calls[1]!.index!);
  assert.equal((post.match(/purgeWithBan\(/g) ?? []).length, 2, "a purge the switch does not decide");
  assert.doesNotMatch(unban, /runPurge|purgeDeps/, "an unban removed lines");
  const purgeRoute = read("../purge/route.ts");
  assert.match(purgeRoute, /await runPurge\(purgeDeps\(mod, targetId\), \{ targetId, accounts, windowMinutes, batchId \}\);/);
  assert.match(unban.trimEnd(), /return Response\.json\(\{ ok: true, batchId, platforms: \[\.\.\.platforms\] \}\);\n\}$/, "vacuity: the scan reached the end of the route");
  assert.equal((post.match(/clickedSkipped: clicked === "invalid" \}\) : NO_PURGE;/g) ?? []).length, 2, "a branch's purge is not told the clicked line was skipped");
});
