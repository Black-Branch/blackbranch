// Gift recipients exclude Discord bridge ghosts — using the ONE ghost pattern.
//
// WHY. A restated ghost id (`@_discord_` in a JS regex and two SQL LIKEs)
// excludes nothing: the bridge's ghosts are `@discord_<id>:`. The pattern lives
// in discordSender.ts (derived from the bridge's username template, module
// config) and giftServer binds it into SQL — or NULL when the module is off.
//
// The SQL half is checked against a REAL Postgres when SQL_PARSE_DATABASE_URL
// is set (CI's throwaway, replayed database): the statements are read out of
// giftServer.ts and executed inside a rolled-back transaction, because a mock
// pool cannot tell whether `!~ $3` means what the JS regex means.
//
// Run: node --test app/lib/giftGhostFilter.test.ts

import "./testInstallValues.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { isDiscordGhost, discordGhostPattern } from "./discordSender.ts";
import { staffMatrixIds } from "./staff.ts";
import { columnEntitledSql } from "./subscriptions/entitlement.ts";

// The staff accounts are CONFIGURED (instance keys streamer.matrixId + bot.matrixId) — the
// test says which two they are.
process.env.STREAMER_MATRIX_ID = "@casey:site.test";
process.env.BOT_MATRIX_ID = "@helperbot:site.test";
const STAFF_MATRIX_IDS = staffMatrixIds();
const PATTERN = discordGhostPattern();
assert.equal(PATTERN, "^@discord_[0-9]+:", "premise: the test build's bridge template is the real one");

// A REAL bridge ghost id (the discordSender.test.ts fixture), and the old wrong shape.
const GHOST = "@discord_100000000000000001:site.test";
const OLD_SHAPE = "@_discord_1:site.test";
const PERSON = "@someone:site.test";

const raw = readFileSync(join(process.cwd(), "app/lib/giftServer.ts"), "utf8");
const src = stripComments(raw);

test("the shared predicate: real ghosts yes, people and lookalikes no", () => {
  assert.equal(isDiscordGhost(GHOST), true);
  assert.equal(isDiscordGhost("@discord_1:example.org"), true, "a ghost on any server");
  for (const id of [PERSON, OLD_SHAPE, "@discordant:site.test", "@discord_abc:site.test"]) {
    assert.equal(isDiscordGhost(id), false, id);
  }
});

test("giftServer carries no private copy of the ghost pattern", () => {
  // Tail anchor: the negative assertions below go green over a short read.
  assert.match(raw.slice(-400), /\}\s*$/, "giftServer.ts did not end as expected — the read is truncated");
  assert.ok(src.includes("export function startGiftExpirySweep") || src.includes("export async function startGiftExpirySweep"),
    "vacuity anchor: giftServer's exports are gone — scan is reading the wrong file");
  assert.doesNotMatch(src, /_discord_/i, "a restated ghost form — use discordSender's discordGhostPattern()");
  assert.doesNotMatch(src, /'@[^'\s:]+:[^'\s]+'/, "staff ids written into SQL — bind staffMatrixIds()");
  // Positive: both SQL filters bind the shared pattern, and the JS check uses the predicate.
  assert.equal((src.match(/\(\$(\d)::text IS NULL OR (?:u\.)?matrix_id !~ \$\1\)/g) ?? []).length, 2,
    "both recipient queries filter ghosts by the shared pattern, and a NULL (module off) excludes nobody");
  assert.equal((src.match(/\bdiscordGhostPattern\b/g) ?? []).length, 3, "imported once, bound twice");
  const giftable = src.slice(src.indexOf("export function isGiftableRecipient"));
  assert.match(giftable.slice(0, 300), /isDiscordGhost\(matrixId\)/);
});

/** A `pool.query(` template literal from giftServer.ts, cooked (escapes applied)
 *  the way the runtime sees it. None of these interpolate, which the guard checks. */
function sqlStartingWith(head: string): string {
  const at = src.indexOf("`" + head);
  assert.ok(at > 0, `no query starting "${head}" in giftServer.ts — the extractor is blind`);
  const end = src.indexOf("`", at + 1);
  // The one interpolation these use: the records' entitlement fragment (community recipients skip
  // anyone already a Supporter), expanded exactly as the runtime builds it.
  const marker = "$" + '{columnEntitledSql("u.matrix_id", "$5")}'; // the interpolation's SOURCE text, not a template
  const body = src.slice(at + 1, end).replace(marker, () => columnEntitledSql("u.matrix_id", "$5"));
  assert.ok(!body.includes("${"), "this query interpolates — the extractor would mis-read it");
  // Template-literal cooking for the only escapes these use: `\\` → `\`.
  assert.ok(!/\\[nrtux0-9]/.test(body), "an escape this cooker does not handle");
  return body.replace(/\\(.)/g, "$1");
}

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";

test("against real Postgres: both recipient queries drop ghosts and staff, keep people",
  { skip: DB_URL ? false : "SQL_PARSE_DATABASE_URL not set (CI sets it)" }, async () => {
  const suggestSql = sqlStartingWith("SELECT matrix_id, display_name FROM site.users\n       WHERE (matrix_id ILIKE");
  const communitySql = sqlStartingWith("SELECT u.matrix_id FROM site.users u");
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    const ids = [GHOST, PERSON, ...STAFF_MATRIX_IDS];
    await db.query(
      `INSERT INTO site.users (matrix_id, display_name) SELECT id, 'probe' FROM unnest($1::text[]) id`,
      [ids],
    );
    // The SQL regex agrees with the JS one on every id.
    const { rows: agree } = await db.query<{ id: string; ghost: boolean }>(
      `SELECT id, id ~ $1 AS ghost FROM unnest($2::text[]) id`,
      [PATTERN, [...ids, OLD_SHAPE, "@discordant:x"]],
    );
    for (const r of agree) assert.equal(r.ghost, isDiscordGhost(r.id), r.id);

    // The real statements with the real parameter shapes.
    const like = "%";
    const sug = await db.query<{ matrix_id: string }>(suggestSql, [like, null, PATTERN]);
    const sugIds = sug.rows.map((r) => r.matrix_id);
    assert.ok(sugIds.includes(PERSON), "a person must be suggested");
    assert.ok(!sugIds.includes(GHOST), "a ghost must not be suggested");

    const com = await db.query<{ matrix_id: string }>(communitySql, [null, 50, [...STAFF_MATRIX_IDS], PATTERN, ["stripe", "paypal"]]);
    const comIds = com.rows.map((r) => r.matrix_id);
    assert.ok(comIds.includes(PERSON), "a person must be eligible");
    assert.ok(!comIds.includes(GHOST), "a ghost must never be picked");
    for (const s of STAFF_MATRIX_IDS) assert.ok(!comIds.includes(s), `${s} must never be picked`);

    // Module OFF binds NULL — and `matrix_id !~ NULL` is NULL, which would drop EVERY row
    // (the NOT-IN trap). The IS NULL arm must keep people eligible.
    const off = await db.query<{ matrix_id: string }>(communitySql, [null, 50, [...STAFF_MATRIX_IDS], null, ["stripe", "paypal"]]);
    assert.ok(off.rows.map((r) => r.matrix_id).includes(PERSON), "module off must not exclude everyone");
    const offSug = await db.query<{ matrix_id: string }>(suggestSql, [like, null, null]);
    assert.ok(offSug.rows.map((r) => r.matrix_id).includes(PERSON), "module off must not exclude everyone (suggest)");
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
});
