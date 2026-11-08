// Source scan (the route's aliased imports keep it out of node --test). Allow on a held line posts it
// AS ITS SENDER and never for a sender banned since the hold (A3-04): a platform release names the
// held row's canonical, which stream-api posts under and refuses when the ban hold holds it
// (stream-api/chat-release.test.js runs that half); a native release checks site.bans first. Either
// refusal drops the line and tells the mod why. The ceiling on WHO may resolve a line is pinned by
// app/lib/modCeilingRoutes.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { stripComments } from "../../../../lib/testSource.ts";
import { bannedNow } from "../../../../lib/platformRetry.ts";

const raw = readFileSync(join(import.meta.dirname, "route.ts"), "utf8");
const src = stripComments(raw);
const hook = stripComments(readFileSync(join(import.meta.dirname, "../../../../lib/useAutomodQueue.ts"), "utf8"));

test("a released platform line names the held row's sender; a banned or deleted sender's line is dropped with the reason", () => {
  const release = src.indexOf('streamApiFetch("/chat", {');
  assert.ok(release > 0, "the platform release was not found");
  assert.match(src.slice(release, release + 600), /\.\.\.\(row\.user_id \? \{ canonicalId: row\.user_id \} : \{\}\)/,
    "the platform release does not carry the held row's canonical");
  assert.match(src, /if \(released\?\.status === 409\) \{[\s\S]{0,200}why === "sender_banned" \|\| why === "sender_gone"\) return dropHeld\(rowId, mod, why\)/);
  const nativeBan = src.indexOf("FROM site.bans WHERE matrix_id = $1");
  const nativeSend = src.indexOf('streamApiFetch("/chat/native"');
  assert.ok(nativeBan > 0 && nativeBan < nativeSend, "a native sender's ban is not checked before the release");
  assert.match(src.slice(nativeBan, nativeSend), /if \(banned\) return dropHeld\(rowId, mod, "sender_banned"\);/);
  assert.match(src, /async function dropHeld\([\s\S]*?SET status = 'denied', resolved_by = \$2[\s\S]*?\{ status: 409 \}/);
  // The mod is told why, in words.
  assert.match(hook, /b\.error === "sender_banned"\) return \{ refused: /);
  assert.match(hook, /b\.error === "sender_gone"\) return \{ refused: /);
});

test("a gone sender is never said to have deleted their account (it may be a merge)", () => {
  assert.match(hook, /b\.error === "sender_gone"\) return \{ refused: "Not posted — the sender's chat identity no longer exists here\." \}/);
  assert.doesNotMatch(hook, /deleted their account/);
});

// W4 residual R1: a PLATFORM-ONLY sender's ban is held at the chat door for 15 minutes only (the
// platform's own ban takes over — stream-api ban-hold.js), so an Allow pressed later posted a banned
// sender's held line. The route now asks their standing first (platformRetry.ts bannedNow, config/canonical-standing.mjs).
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const RUN = (`${process.pid.toString(16)}${Date.now().toString(16)}`).slice(-10).padStart(10, "0");

test("a platform-only sender banned since the hold is dropped after the bridge window", { skip: unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  const sender = `a1${RUN}`;            // a 12-hex canonical, platform-only
  const clean = () => pool.query(`DELETE FROM site.mod_log WHERE target_id = $1`, [sender]);
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const log = (action: string, agoMin: number, expiresInMin: number | null = null) => pool.query(
    `INSERT INTO site.mod_log (action, target_id, performed_by, expires_at, created_at, batch_id)
     VALUES ($1, $2, '@mod:site.test', CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END,
             now() - make_interval(mins => $4::int), gen_random_uuid())`, [action, sender, expiresInMin, agoMin]);

  assert.equal(await bannedNow(sender, q), false, "a sender with no action was refused");
  // Held 30 minutes ago; banned 20 minutes later; Allow pressed now — past the 15-minute bridge.
  await log("ban", 10);
  assert.equal(await bannedNow(sender, q), true, "a platform-only sender banned since the hold was posted");
  // Unbanned after the ban: the line may be posted.
  await log("unban", 5);
  assert.equal(await bannedNow(sender, q), false, "an unbanned sender's line was refused");
  // A timeout: refused while it runs, posted once it has ended.
  await log("timeout", 1, 60);
  assert.equal(await bannedNow(sender, q), true);
  await pool.query(`UPDATE site.mod_log SET expires_at = now() - interval '1 second' WHERE target_id = $1 AND action = 'timeout'`, [sender]);
  assert.equal(await bannedNow(sender, q), false, "an ended timeout still refused the line");
  await assert.rejects(bannedNow(sender, async () => { throw new Error("db down"); }), /db down/);

  // The route asks before the platform release, and drops the line as sender_banned.
  const ask = src.indexOf("await bannedNow(row.user_id, ");
  const release = src.indexOf('streamApiFetch("/chat", {');
  assert.ok(ask > 0 && ask < release, "the platform release does not ask for a standing ban first");
  assert.match(src.slice(ask, ask + 300), /dropHeld\(rowId, mod, "sender_banned"\)/);
});

// Push review on fecab52b: a merge closes a banned loser's held lines as denied (stream-api
// identity-merge-held.db.test.js). A stale panel's Allow on such a row — or on any row already
// resolved — must be refused in words, never answered { ok: true } with nothing posted.
test("an Allow on one of our rows that is already resolved is refused, before any release", () => {
  const own = src.indexOf('if (row.source !== "twitch" || !msgId) {');
  const refuse = src.indexOf('return Response.json({ error: "already_resolved", status: row.status }, { status: 409 });', own);
  const release = src.indexOf('streamApiFetch("/chat"', own);
  assert.ok(own > 0 && refuse > own && refuse < release, "an already-resolved own row reaches the release or the ok answer");
  assert.match(src.slice(own, refuse), /const actionable = row\.status === "pending" \|\| row\.status === "blocked" \|\| \(row\.status === "flagged" && row\.source === "ai"\);\s*if \(!actionable\)/);
});

test("vacuity anchor: the scan reached dropHeld at the end of the file", () => {
  assert.match(raw.trimEnd(), /return Response\.json\(\{ error: why \}, \{ status: 409 \}\);\n\}$/);
});
