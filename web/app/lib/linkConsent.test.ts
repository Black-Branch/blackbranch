// ONE consent predicate for showing a cross-platform link (config/public-id.mjs noOptOutSql, used
// through linkConsent.ts here and pseudonym.js in stream-api). Security review on this slice found
// the readers had each written their own: some consulted only site.platform_links and missed an
// account joined by its native stream.links row (the moderation ceiling's gap), some took any one
// account's opt-in for everyone's. The predicate was run against a throwaway Postgres with the
// baseline schema: a canonical whose natively linked account opted OUT stays hidden on the boards,
// the pinned banner, the cards and the credit line even though its other account opted in.
// Run: node --test app/lib/linkConsent.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Pool } from "pg";
import { noOptOutSql } from "./linkConsent.ts";
import { stripComments } from "./testSource.ts";
import { IDENTITY_SPAN_SQL } from "./identitySpan.ts";

test("the predicate consults BOTH link tables, and any opted-out account hides the link", () => {
  const sql = noOptOutSql("x.c");
  assert.match(sql, /SELECT matrix_id FROM site\.platform_links WHERE canonical_id = x\.c/);
  assert.match(sql, /UNION SELECT platform_id FROM stream\.links WHERE platform IN \('native'[^)]*\) AND canonical = x\.c/);
  assert.match(sql, /^NOT EXISTS \(/);
  assert.match(sql, /WHERE NOT consent_u\.show_links\)\s+AND NOT EXISTS \(SELECT 1 FROM stream\.links consent_l/);
  // …and every platform account on the canonical is still linked (unlink undoes a shown link).
  assert.match(sql, /consent_p\.platform = consent_l\.platform\s+AND consent_p\.platform_id = consent_l\.platform_id\)\)$/);
});

const ROOT = join(process.cwd(), "..");
function files(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${f}`;
    if (f === "node_modules" || f.startsWith(".")) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) { out.push(...files(rel)); continue; }
    if (/\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\./.test(f) && !/\.generated\./.test(f)) out.push(rel);
  }
  return out;
}

test("no file writes its own show_links predicate; every SQL reader of the opt-in uses the one", () => {
  // A reader that picks the account to SHOW tests that account's own flag (`u.show_links`) AND the
  // one predicate. Nothing else may negate or aggregate the flag.
  const READERS = new Set(["web/app/lib/boards.ts", "web/app/lib/pinAuthor.ts", "stream-api/sponsors.js"]);
  const own: string[] = [];
  const missing: string[] = [];
  let seen = 0;
  for (const rel of [...files("web/app"), ...files("web/lib"), ...files("stream-api"), ...files("stream-ingest")]) {
    const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    if (!src.includes("show_links")) continue;
    seen += 1;
    if (/NOT\s+\w+\.show_links|bool_(and|or)\([^)]*show_links/.test(src)) own.push(rel);
    if (READERS.has(rel) && !/noOptOutSql\(/.test(src)) missing.push(rel);
  }
  assert.deepEqual(own, [], "a file negates or aggregates show_links itself");
  assert.deepEqual(missing, [], "a reader of the opt-in skips the one consent predicate");
  assert.ok(seen >= 6, `vacuity anchor: only ${seen} files mention show_links`);
});

test("the cards' identity span and the credit line use it too", () => {
  const span = readFileSync(join(process.cwd(), "app", "lib", "identitySpan.ts"), "utf8");
  assert.match(span, /NOT EXISTS \(SELECT 1 FROM canon WHERE NOT \(\$\{noOptOutSql\("canon\.c"\)\}\)\) AS all_show/);
  const sponsors = readFileSync(join(ROOT, "stream-api", "sponsors.js"), "utf8");
  assert.match(sponsors, /AND \$\{noOptOutSql\('x\.canonical_id'\)\}/);
});

// ── Unlink undoes a shown link ───────────────────────────────────────────────────────────────
// Linking merges a platform identity's canonical into the account's own, and unlinking
// (DELETE /api/account-links) removes the site.platform_links row only: stream.links keeps the
// platform account on the merged canonical, which the account still holds through its native row.
// So consent also needs every platform identity on the canonical to be LIVE-linked (a
// site.platform_links row for that very platform account). Otherwise an unlinked platform name kept
// carrying the site name on its card, its board rows and the sponsor credit line.

test("the predicate is one expression: no caller negates it without parentheses", () => {
  const span = readFileSync(join(process.cwd(), "app", "lib", "identitySpan.ts"), "utf8");
  assert.match(span, /ORDER BY \(u\.matrix_id = \$2::text\) DESC NULLS LAST, u\.created_at DESC LIMIT 1`;\n$/, "END of identitySpan.ts not read");
  let callers = 0;
  for (const rel of [...files("web/app"), ...files("web/lib"), ...files("stream-api")]) {
    const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
    for (const m of src.matchAll(/(\S*)\s*\$\{noOptOutSql\(/g)) {
      callers += 1;
      assert.doesNotMatch(m[1]!, /(^|[^A-Za-z_])NOT$/i,`${rel}: NOT \${noOptOutSql(…)} negates only its first clause — write NOT (\${…})`);
    }
  }
  assert.ok(callers >= 5, `vacuity: only ${callers} interpolated callers found`);
});

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false;

test("unlink: the platform identity's card, board rows and credit line stop carrying the site identity", { skip }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const run = `lcu${process.pid}x${Date.now().toString(36)}`;
  const me = `@${run}:site.test`;
  const canon = (process.pid.toString(16) + Date.now().toString(16)).slice(-12).padStart(12, "0");
  const tw = `${run}-tw`;
  const yt = `${run}-yt`;
  const clean = async () => {
    await pool.query(`DELETE FROM stream.chat_log WHERE user_id = $1`, [canon]);
    await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1`, [me]);
    await pool.query(`DELETE FROM stream.links WHERE canonical = $1`, [canon]);
    await pool.query(`DELETE FROM stream.users WHERE id = $1`, [canon]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [me]);
  };
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  // An opted-in person who linked Twitch and YouTube; linking merged both into their own canonical.
  await pool.query(`INSERT INTO site.users (matrix_id, display_name, show_links) VALUES ($1, 'Casey', true)`, [me]);
  await pool.query(`INSERT INTO stream.users (id, name) VALUES ($1, 'casey')`, [canon]);
  await pool.query(`INSERT INTO stream.links (platform, platform_id, canonical) VALUES ('native', $1, $4), ('twitch', $2, $4), ('youtube', $3, $4)`, [me, tw, yt, canon]);
  await pool.query(`INSERT INTO site.platform_links (matrix_id, platform, platform_id, canonical_id) VALUES ($1, 'twitch', $2, $4), ($1, 'youtube', $3, $4)`, [me, tw, yt, canon]);
  const sid = Number(String(process.pid) + String(Date.now() % 1e6));
  await pool.query(`INSERT INTO stream.sessions (stream_id, started_at, ended_at) VALUES ($1, now() - interval '1 hour', now())`, [sid]);
  t.after(async () => { await pool.query(`DELETE FROM stream.sessions WHERE stream_id = $1`, [sid]).catch(() => {}); });
  await pool.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, stream_id) VALUES ($1, 'twitch', 'casey_tw', 'hi', $2)`, [canon, sid]);

  const require = createRequire(import.meta.url);
  const pseudonym = require("../../../stream-api/pseudonym.js") as { noOptOutSql: (c: string) => string };
  const { faceSql } = await import("./boards.ts");
  const consent = async () => ({
    web: (await pool.query(`SELECT ${noOptOutSql("$1::text")} AS ok`, [canon])).rows[0].ok as boolean,
    // stream-api's sponsor pool reads its own generated copy of the same predicate.
    sponsors: (await pool.query(`SELECT ${pseudonym.noOptOutSql("$1::text")} AS ok`, [canon])).rows[0].ok as boolean,
    // The card: linkFactsServer ANDs the account's own flag with the identity span's all_show.
    card: (await pool.query<{ all_show: boolean }>(IDENTITY_SPAN_SQL, [canon, null])).rows[0]!.all_show,
    board: (await pool.query<{ key: string }>(faceSql("streams"), [null, null])).rows.filter((r) => r.key === me || r.key.includes(canon)).map((r) => r.key),
  });

  assert.deepEqual(await consent(), { web: true, sponsors: true, card: true, board: [me] }, "an opted-in, linked person shows the link");

  // DELETE /api/account-links { platform: 'twitch' } — the route's own statement.
  await pool.query(`DELETE FROM site.platform_links WHERE matrix_id = $1 AND platform = $2`, [me, "twitch"]);

  assert.deepEqual(await consent(), { web: false, sponsors: false, card: false, board: [`c:${canon}|twitch`] },
    "an unlinked platform identity still carries the site identity");
});

test("the unlink route's statement is the one the test runs", () => {
  const raw = readFileSync(join(process.cwd(), "app", "api", "account-links", "route.ts"), "utf8");
  assert.match(raw, /return Response\.json\(\{ ok: true \}\);\n\}\n$/, "END of the route not read");
  const del = stripComments(raw).slice(stripComments(raw).indexOf("export async function DELETE"));
  // The rows go in the ordered unlink helper (platformUnlink.ts, after stream-api's identity split);
  // the route then tells the sponsor pool.
  const lib = stripComments(readFileSync(join(process.cwd(), "app", "lib", "platformUnlink.ts"), "utf8"));
  assert.match(lib, /await deps\.query\(`DELETE FROM site\.platform_links WHERE matrix_id = \$1 AND platform = \$2`, \[matrixId, platform\]\);\s*return \{ ok: true \};\n\}\s*$/,
    "the unlink helper's statement is not the one this test runs");
  assert.match(del, /const result = await unlinkPlatformAccount\(matrixId, platform, \{[\s\S]*?\}\);\s*if \(!result\.ok\) \{[\s\S]*?\}\s*await streamApiFetch\("\/sponsors\/links-changed"/,
    "an unlink does not tell the sponsor pool to re-read");
});
