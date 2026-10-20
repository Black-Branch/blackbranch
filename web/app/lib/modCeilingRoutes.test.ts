// The mod privilege ceiling on EVERY mod route that acts on a person (round 5): unban, delete a
// line, resolve a report, clear a mark, set pronouns, per-person slow mode — plus the Reports view.
//   • against a real Postgres: who each thing names (modTargets.ts) and the ceiling's verdict on it —
//     a mod never acts on an admin or another mod, never closes a case about themselves; an admin may;
//     a mod's Reports list leaves out reports about them and never names the reporter;
//   • a scan: every app/api/mod route either calls assertCanModerate before its first write, or is
//     listed here with the reason it names nobody.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/modCeilingRoutes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { checkModerationCeiling, type CeilingQuery } from "./modCeiling.ts";
import { messageAuthor, normalizeMessageId, reportSubject, markSubject, reportsForViewer, REPORTER_FOR_MODS } from "./modTargets.ts";
import { modDeleteMessage, type ModDeleteDeps } from "./modDelete.ts";
import { stripComments } from "./testSource.ts";

const WEB = process.cwd();
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;
const RUN = `mcr${process.pid}x${Date.now().toString(36)}`;
const hex = (n: number) => (process.pid.toString(16) + Date.now().toString(16) + n.toString(16)).slice(-12).padStart(12, "0");

test("the ceiling on lines, reports, marks and people — real Postgres", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 3 });
  const OWNER = `@${RUN}-owner:site.test`, MOD1 = `@${RUN}-m1:site.test`, MOD2 = `@${RUN}-m2:site.test`, USER = `@${RUN}-u:site.test`;
  const people = [OWNER, MOD1, MOD2, USER];
  const [cOwner, cMod1, cMod2, cChatter] = [hex(1), hex(2), hex(3), hex(4)];
  const canon = [cOwner, cMod1, cMod2, cChatter];
  const clean = async () => {
    await pool.query(`DELETE FROM site.user_marks WHERE matrix_id = ANY($1) OR canonical_id = ANY($2)`, [people, canon]);
    await pool.query(`DELETE FROM site.reports WHERE reporter_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM site.chat_messages WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = ANY($1)`, [people]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM stream.users WHERE id = ANY($1)`, [canon]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = ANY($1)`, [people]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });

  await pool.query(`INSERT INTO site.users (matrix_id, display_name, is_admin, is_mod) VALUES
    ($1, 'owner', true, false), ($2, 'modone', false, true), ($3, 'modtwo', false, true), ($4, 'user', false, false)`, people);
  for (const c of canon) await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, $1)`, [c]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2), ('twitch', $3, $4), ('twitch', $5, $6), ('kick', $7, $8)`,
    [OWNER, cOwner, `${RUN}-m1tw`, cMod1, `${RUN}-m2tw`, cMod2, `${RUN}-chat`, cChatter]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $3), ($4, 'twitch', $5, $6)`,
    [MOD1, `${RUN}-m1tw`, cMod1, MOD2, `${RUN}-m2tw`, cMod2]);
  const line = async (who: string) => String((await pool.query(`INSERT INTO site.chat_messages (matrix_id, message) VALUES ($1, 'hi') RETURNING id`, [who])).rows[0].id);
  const logLine = async (c: string, platform: string) => String((await pool.query(
    `INSERT INTO stream.chat_log (user_id, platform, username, message) VALUES ($1, $2, 'x', 'hi') RETURNING id`, [c, platform])).rows[0].id);
  const report = async (about: { id?: string; canonical?: string }, by = USER) => Number((await pool.query(
    `INSERT INTO site.reports (reported_id, reported_canonical_id, reporter_id, reason) VALUES ($1, $2, $3, 'r') RETURNING id`,
    [about.id ?? null, about.canonical ?? null, by])).rows[0].id);
  const mark = async (about: { id?: string; canonical?: string }) => Number((await pool.query(
    `INSERT INTO site.user_marks (matrix_id, canonical_id, reason, source, created_by) VALUES ($1, $2, 'm', 'mod', 'mod') RETURNING id`,
    [about.id ?? null, about.canonical ?? null])).rows[0].id);

  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  const ceiling = async (actor: string, target: string | null, selfCase = false) =>
    target === null ? "nobody" : ((await checkModerationCeiling(actor, target, q as CeilingQuery, { selfCase }))?.status ?? "allowed");

  await t.test("delete a line: by its author — an admin's or a mod's is refused to a mod", async () => {
    const [ownerLine, mod2Line, userLine, mod1Line] = [await line(OWNER), await line(MOD2), await line(USER), await line(MOD1)];
    const mod2Twitch = await logLine(cMod2, "twitch"), chatterKick = await logLine(cChatter, "kick"), ownerNative = await logLine(cOwner, "native");
    assert.equal(await ceiling(MOD1, await messageAuthor("native", ownerLine, q)), 403);
    assert.equal(await ceiling(MOD1, await messageAuthor("native", mod2Line, q)), 403);
    assert.equal(await ceiling(MOD1, await messageAuthor("twitch", mod2Twitch, q)), 403, "another mod's linked platform line");
    assert.equal(await ceiling(MOD1, await messageAuthor("native", userLine, q)), "allowed");
    assert.equal(await ceiling(MOD1, await messageAuthor("kick", chatterKick, q)), "allowed", "a platform-only chatter");
    assert.equal(await ceiling(MOD1, await messageAuthor("native", mod1Line, q)), "allowed", "their own line");
    assert.equal(await ceiling(OWNER, await messageAuthor("native", mod2Line, q)), "allowed", "an admin on a mod");
    assert.equal(await messageAuthor("twitch", ownerNative, q), cOwner);
    assert.equal(await messageAuthor("native", "999999999999", q), null, "an unknown line names nobody");
    assert.equal(normalizeMessageId("1; drop"), null);
  });

  await t.test("delete with a MALFORMED id: 400, and nothing is read, deleted, logged or fanned out", async () => {
    const ownerLine = await line(OWNER);
    const userLine = await line(USER);
    const done: string[] = [];
    const deps: ModDeleteDeps = {
      query: q,
      ceiling: (actor, target) => checkModerationCeiling(actor, target, q as CeilingQuery),
      deleteNative: async (_m, id) => { done.push(`native:${id}`); },
      streamDelete: async (id, p) => { done.push(`stream:${p}:${id}`); },
      log: async (target) => { done.push(`log:${target}`); },
      fanOut: (id, p) => { done.push(`fan:${p}:${id}`); },
    };
    const n = Number(ownerLine);
    for (const bad of [` ${ownerLine}`, `${ownerLine} `, `${ownerLine}abc`, `+${ownerLine}`, `${ownerLine}.0`, n + 0.5, -n, { id: n }, [n], null, "", "1e3", "0x10"]) {
      for (const platform of ["native", "twitch"]) {
        const res = await modDeleteMessage(MOD1, platform, bad, deps);
        assert.equal(res.status, 400, `${JSON.stringify(bad)} on ${platform} was not refused`);
      }
    }
    assert.deepEqual(done, [], "a malformed id reached a write");
    // Well-formed: the owner's line is refused to a mod; a number and its digit string are the same line.
    assert.equal((await modDeleteMessage(MOD1, "native", ownerLine, deps)).status, 403);
    assert.equal((await modDeleteMessage(MOD1, "native", n, deps)).status, 403);
    assert.deepEqual(done, []);
    assert.equal((await modDeleteMessage(MOD1, "native", Number(userLine), deps)).status, 200);
    assert.deepEqual(done, [`native:${userLine}`]);
    const kick = await logLine(cChatter, "kick");
    assert.equal((await modDeleteMessage(MOD1, "kick", kick, deps)).status, 200);
    assert.deepEqual(done.slice(1), [`stream:kick:${kick}`, `log:kick:${kick}`, `fan:kick:${kick}`], "the action used another value than the check");
    // A well-formed id that finds no line names nobody — the only case the check is skipped.
    assert.equal((await modDeleteMessage(MOD1, "twitch", "999999999999", deps)).status, 200);
  });

  await t.test("resolve a report: never one about yourself (account or linked identity) or another mod; an admin may", async () => {
    const aboutMe = await report({ id: MOD1 }), aboutMyTwitch = await report({ canonical: cMod1 });
    const aboutMod2 = await report({ id: MOD2 }), aboutUser = await report({ id: USER }), aboutChatter = await report({ canonical: cChatter });
    const aboutOwner = await report({ id: OWNER });
    assert.equal(await ceiling(MOD1, await reportSubject(aboutMe, q), true), 403);
    assert.equal(await ceiling(MOD1, await reportSubject(aboutMyTwitch, q), true), 403, "a report about the mod's linked platform identity");
    assert.equal(await ceiling(MOD1, await reportSubject(aboutMod2, q), true), 403);
    assert.equal(await ceiling(MOD1, await reportSubject(aboutOwner, q), true), 403);
    assert.equal(await ceiling(MOD1, await reportSubject(aboutUser, q), true), "allowed");
    assert.equal(await ceiling(MOD1, await reportSubject(aboutChatter, q), true), "allowed");
    assert.equal(await ceiling(OWNER, await reportSubject(aboutMe, q), true), "allowed");
    assert.equal(await ceiling(OWNER, await reportSubject(aboutOwner, q), true), "allowed", "an admin may close a case about themselves");
    assert.equal(await reportSubject(987654321, q), null);
  });

  await t.test("clear a mark: never your own; a chatter's is fine", async () => {
    const onMod1 = await mark({ id: MOD1 });
    assert.equal(await ceiling(MOD1, await markSubject(onMod1, q), true), 403);
    assert.equal(await ceiling(MOD1, await markSubject(await mark({ canonical: cMod1 }), q), true), 403);
    assert.equal(await ceiling(MOD1, await markSubject(await mark({ canonical: cChatter }), q), true), "allowed");
    assert.equal(await ceiling(MOD2, await markSubject(onMod1, q), true), 403, "another mod's mark");
  });

  await t.test("unban, pronouns, per-person slow mode: a person by id or canonical", async () => {
    assert.equal(await ceiling(MOD1, MOD2), 403, "a mod lifting another mod's timeout");
    assert.equal(await ceiling(MOD1, cOwner), 403, "the owner's pronouns by canonical");
    assert.equal(await ceiling(MOD1, cMod2), 403);
    assert.equal(await ceiling(MOD1, cMod1), "allowed", "their own pronouns");
    assert.equal(await ceiling(MOD1, USER), "allowed");
  });

  await t.test("M1: two site accounts on one identity — the ban's target list names both", async () => {
    const { linkedMatrixIds } = await import("./canonicalIdentity.ts");
    const ALT = `@${RUN}-alt:site.test`;
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [ALT]);
    try {
      await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $2)`, [USER, cChatter]);
      await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'kick', $2, $3)`, [ALT, `${RUN}-chat`, cChatter]);
      assert.deepEqual((await linkedMatrixIds(cChatter, q as never)).sort(), [ALT, USER].sort());
    } finally {
      await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [ALT]);
      await pool.query(`DELETE FROM stream.links WHERE platform = 'native' AND platform_id = $1`, [USER]);
      await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [ALT]);
    }
  });

  await t.test("the Reports list: a mod sees no report about themselves and no reporter name; an admin sees all", async () => {
    const rows = (await pool.query(
      `SELECT r.id, r.reported_id, r.reported_canonical_id, COALESCE(pu.display_name, r.reporter_id) AS reporter
         FROM site.reports r LEFT JOIN site.users pu ON pu.matrix_id = r.reporter_id
        WHERE r.reporter_id = ANY($1) ORDER BY r.id`, [people])).rows as { id: number; reported_id: string | null; reported_canonical_id: string | null; reporter: string }[];
    assert.ok(rows.length >= 6, "vacuity: the reports were not read");
    const forMod = await reportsForViewer(rows, { id: MOD1, admin: false }, q);
    assert.ok(forMod.every((r) => r.reported_id !== MOD1 && r.reported_canonical_id !== cMod1), "a report about the mod was shown to them");
    assert.equal(forMod.length, rows.length - 2);
    assert.ok(forMod.every((r) => r.reporter === REPORTER_FOR_MODS), "a mod was shown who reported");
    const forAdmin = await reportsForViewer(rows, { id: OWNER, admin: true }, q);
    assert.equal(forAdmin.length, rows.length);
    assert.ok(forAdmin.some((r) => r.reporter === "user"));
    await assert.rejects(reportsForViewer(rows, { id: MOD1, admin: false }, async () => { throw new Error("db down"); }), /db down/,
      "a failed identity read must not show the list");
  });
});

// ── every mod route ─────────────────────────────────────────────────────────

// Routes that act on no one person, with why. A new route is neither here nor guarded → fails.
const NAMES_NOBODY: Record<string, string> = {
  "announce": "posts the site's own announcement",
  "automod/enabled": "a site-wide switch",
  "automod": "reads the held list",
  "automod/resolve": "a held line — staff, mods and admins are exempt from automod (automodHold.ts), so a hold is never theirs",
  "bans/active": "reads",
  "bans": "reads",
  "bar": "the support bar",
  "blocklist": "a term list",
  "chat-history": "reads",
  "embed": "the embeds list",
  "emotes": "the emote set",
  "identity/resolve": "reads ids for the mod's own client",
  "linkgate": "a site-wide posture",
  "lockdown": "site-wide levers",
  "log": "reads",
  "loop-videos": "the loop list",
  "marks": "reads (GET only); clearing is marks/[id]/clear",
  "memory/forget": "admin only (requireAdmin) — the ceiling only limits non-admins",
  "payments": "admin only (requireAdmin), reads",
  "platform-actions": "reads",
  "platform-availability": "reads",
  "player-sources": "the player list",
  "setmod": "admin only (requireAdmin)",
  "stream/end": "ends the stream",
  "timer": "the stream timer",
};

// The writes a guard must come before, per verb.
const WRITE = /pool\.query\(\s*`\s*(?:INSERT|UPDATE|DELETE)|streamApiFetch\(|askPronounCommand\((?![^)]*resolveOnly: true)|clearMark\(|deleteSiteMessageEverywhere\(|fanOut[A-Z]\w*\(|\b(?:ban|unban|delete|purge)On[A-Z]\w*\(/;

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(WEB, dir))) {
    const rel = `${dir}/${f}`;
    if (statSync(join(WEB, rel)).isDirectory()) out.push(...routes(rel));
    else if (f === "route.ts") out.push(rel);
  }
  return out;
}

const read = (p: string) => {
  const raw = readFileSync(join(WEB, p), "utf8");
  assert.match(raw, /\}\n?$/, `${p}: END not read`);
  return stripComments(raw);
};

/** Each exported verb's body that takes a person: the guard must be called in it, before its first write. */
function verbs(src: string): { verb: string; body: string }[] {
  const at = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)];
  // Each verb's own body: up to the first top-level closing brace after it.
  return at.map((m) => {
    const end = src.indexOf("\n}\n", m.index);
    assert.ok(end > 0, `${m[1]}: its closing brace was not found`);
    return { verb: m[1] ?? "", body: src.slice(m.index, end) };
  });
}

test("every mod route that acts on a person calls the ceiling before its first write", () => {
  const files = routes("app/api/mod");
  assert.ok(files.length >= 30, `vacuity: only ${files.length} mod routes found`);
  const seen = new Set<string>();
  for (const file of files) {
    const name = file.replace(/^app\/api\/mod\//, "").replace(/\/route\.ts$/, "");
    seen.add(name);
    const src = read(file);
    if (name in NAMES_NOBODY) {
      assert.doesNotMatch(src, /assertCanModerate\(/, `${name}: guarded AND listed as naming nobody — take it off the list`);
      continue;
    }
    const writers = verbs(src).filter((v) => WRITE.test(v.body));
    assert.ok(writers.length > 0, `${name}: no writing verb found — list it in NAMES_NOBODY with a reason`);
    for (const { verb, body } of writers) {
      const guard = body.indexOf("assertCanModerate(");
      const write = body.search(WRITE);
      assert.ok(guard > 0, `${name} ${verb}: writes without the moderation ceiling`);
      assert.ok(guard < write, `${name} ${verb}: the ceiling comes after a write`);
    }
  }
  for (const name of Object.keys(NAMES_NOBODY)) assert.ok(seen.has(name), `NAMES_NOBODY lists ${name}, which no longer exists`);
});

test("the person each route guards is the right one", () => {
  const del = read("app/api/mod/delete/route.ts");
  assert.match(del, /return modDeleteMessage\(mod, platform, body\.messageId, \{/);
  assert.match(del, /ceiling: \(actor, target\) => assertCanModerate\(actor, target\)/);
  assert.doesNotMatch(del, /Number\(|String\(/, "the route reads the id itself, beside the helper's one normalisation");
  const support = read("app/api/mod/support/route.ts");
  assert.match(support, /reportSubject\(id, /);
  assert.match(support, /assertCanModerate\(modId, subject, \{ selfCase: true \}\)/);
  assert.match(support, /reportsForViewer\(/);
  const clear = read("app/api/mod/marks/[id]/clear/route.ts");
  assert.match(clear, /markSubject\(id, /);
  assert.match(clear, /assertCanModerate\(mod, subject, \{ selfCase: true \}\)/);
  const ban = read("app/api/mod/ban/route.ts");
  const unban = ban.slice(ban.indexOf("export async function DELETE"));
  assert.match(unban, /assertCanModerate\(mod, /);
  // M1: a canonical names EVERY site account linked to it, and a ban/unban by canonical acts on each.
  assert.doesNotMatch(ban, /platform_links[^`]*LIMIT 1/, "an unordered LIMIT 1 picks an arbitrary account");
  assert.match(ban, /linkedMatrixIds\(canonicalId, /);
  assert.equal((ban.match(/for \(const t of targets\)/g) ?? []).length, 2, "ban and unban must each act on every linked account");
  const pronouns = read("app/api/mod/pronouns/route.ts");
  assert.match(pronouns, /resolveOnly: true/, "a name is resolved to its person before the ceiling, never after the write");
});

test("help-desk tickets are the Admin Panel's: the mod route hands them to admins only", () => {
  const support = read("app/api/mod/support/route.ts");
  const get = support.slice(support.indexOf("export async function GET"), support.indexOf("export async function POST"));
  assert.match(get, /admin \?\s*pool\.query\(/, "tickets are read for every mod");
  const post = support.slice(support.indexOf("export async function POST"));
  assert.match(post, /if \(!admin\) return new Response\("Forbidden", \{ status: 403 \}\)/);
});
