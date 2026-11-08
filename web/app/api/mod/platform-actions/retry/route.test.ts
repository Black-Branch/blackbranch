// Source scan (the route's aliased imports keep it out of node --test): a retry
// re-runs a stored ban / timeout / unban as the CURRENT mod, so it must pass the
// same privilege ceiling as the original action. It did not: any mod could
// re-run a row by id against the owner — including through the broadcaster
// token fallback, which can ban a platform moderator. The ceiling itself
// (native canonicals, every linked account, 503 on a failed lookup) is pinned
// behaviourally by modCeiling.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { stripComments } from "../../../../lib/testSource.ts";
import { newestActions, standingOf, supersededLabel } from "../../../../lib/platformRetry.ts";

const src = stripComments(readFileSync(join(import.meta.dirname, "route.ts"), "utf8"));

test("a retry passes the moderation ceiling for the row's target before any platform call", () => {
  const read = src.indexOf("FROM site.platform_mod_actions WHERE id = $1");
  const noTarget = src.indexOf("if (!row.target_id)");
  const check = src.indexOf("await assertCanModerate(mod, row.target_id)");
  assert.ok(read > 0, "the row is read");
  assert.ok(noTarget > read, "a row with no target is refused first");
  assert.ok(check > noTarget, "the ceiling is checked on the stored target");
  assert.match(src.slice(check, check + 120), /if \(denied\) return denied;/, "a refusal (403, or 503 when undecidable) is returned");
  for (const call of ["banOnTwitch(", "banOnKick(", "banOnYouTube(", "unbanOnTwitch(", "unbanOnKick(", "unbanOnYouTube("]) {
    const at = src.indexOf(`await ${call}`);
    assert.ok(at > check, `${call} runs before the ceiling`);
  }
  assert.match(src, /import \{ requireMod, assertCanModerate \} from "@\/app\/lib\/admin";/);
});

// ── A3-05: a retry only while the row's batch is still the target's newest action ──────────────

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
if (unsafe && process.env.CI) throw new Error("SQL_PARSE_DATABASE_URL must be set in CI — this gate must not skip itself there");
const RUN = `rty${process.pid}x${Date.now().toString(36)}`;

test("a retry after a later unban or ban is refused", { skip: unsafe ? "SQL_PARSE_DATABASE_URL unset or unsafe" : false }, async (t) => {
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  const clean = () => pool.query(`DELETE FROM site.mod_log WHERE target_id LIKE $1`, [`${RUN}%`]);
  await clean();
  t.after(async () => { await clean(); await pool.end(); });
  const log = async (target: string, action: string, agoSec: number, expiresInSec: number | null = null) => {
    const batch = randomUUID();
    await pool.query(
      `INSERT INTO site.mod_log (action, target_id, performed_by, expires_at, batch_id, created_at)
       VALUES ($1, $2, '@mod:site.test', CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END, $4, now() - make_interval(secs => $5::int))`,
      [action, target, expiresInSec, batch, agoSec]);
    return batch;
  };
  const standing = async (target: string, action: string, batch: string | null) =>
    standingOf({ action, batch_id: batch }, (await newestActions([target], q)).get(target));

  // Banned, the platform ban failed, then unbanned on the site: the old ban row must not re-ban.
  const A = `${RUN}-a`;
  const banA = await log(A, "ban", 600);
  const unbanA = await log(A, "unban", 60);
  assert.deepEqual(await standing(A, "ban", banA), { ok: false, supersededBy: "unban" });
  assert.deepEqual(await standing(A, "unban", unbanA), { ok: true, durationSeconds: null }, "the newest action is retryable");

  // An old failed unban must not lift the ban the person is serving now.
  const B = `${RUN}-b`;
  const unbanB = await log(B, "unban", 600);
  await log(B, "ban", 60);
  assert.deepEqual(await standing(B, "unban", unbanB), { ok: false, supersededBy: "ban" });

  // A timeout is retried for what it has left — never restarted at full length; an ended one not at all.
  const C = `${RUN}-c`;
  const toC = await log(C, "timeout", 60, 300);
  const c = await standing(C, "timeout", toC);
  assert.ok(c.ok && c.durationSeconds !== null && c.durationSeconds > 290 && c.durationSeconds <= 300, `a running timeout's remainder: ${JSON.stringify(c)}`);
  const D = `${RUN}-d`;
  const toD = await log(D, "timeout", 3600, -60);
  assert.deepEqual(await standing(D, "timeout", toD), { ok: false, supersededBy: "ended" });

  // A row with no batch (before batches existed) cannot be judged: refused.
  assert.deepEqual(await standing(A, "ban", null), { ok: false, supersededBy: "unknown" });
  // A retry of the retry: the answer does not change (the retry writes no mod_log row).
  assert.deepEqual(await standing(A, "ban", banA), { ok: false, supersededBy: "unban" });
  assert.equal(supersededLabel("unban"), "Superseded by a later unban");
});

test("the retry route and the history list ask the same standing before any platform call", () => {
  const standingAt = src.indexOf("standingOf(row, ");
  const check = src.indexOf("await assertCanModerate(mod, row.target_id)");
  assert.ok(standingAt > check, "the standing is not checked after the ceiling");
  assert.match(src.slice(standingAt, standingAt + 300), /if \(!standing\.ok\) return Response\.json\(\{ error: "superseded", supersededBy: standing\.supersededBy \}, \{ status: 409 \}\);/);
  for (const call of ["banOnTwitch(", "banOnKick(", "banOnYouTube(", "unbanOnTwitch(", "unbanOnKick(", "unbanOnYouTube("]) {
    assert.ok(src.indexOf(`await ${call}`) > standingAt, `${call} runs before the standing check`);
  }
  assert.match(src, /const dur = standing\.durationSeconds;/, "a timeout is retried at its full stored length");
  const list = stripComments(readFileSync(join(import.meta.dirname, "../route.ts"), "utf8"));
  assert.match(list, /supersededBy: /, "the history rows do not say what superseded them");
  const panel = stripComments(readFileSync(join(import.meta.dirname, "../../../../features/moderation/sections/HistorySection.tsx"), "utf8"));
  assert.match(panel, /a\.supersededBy \? \(/, "the panel still offers Retry on a superseded row");
});

test("vacuity anchor: the scan reached the handler's final refusal", () => {
  assert.ok(src.lastIndexOf('return Response.json({ error: "unsupported_retry" }, { status: 422 });') > src.indexOf("unbanOnYouTube("));
  assert.match(src, /\}\s*$/);
});
