// The one visibility rule (messageVisibleSql) on every PUBLIC read of chat content: a mod-deleted
// message and an account deletion's kept evidence are `is_deleted` rows — moderators may read
// them, nobody else. One test per public read path, plus the rule itself on a real Postgres.
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/messageVisibility.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "pg";
import { stripComments } from "./testSource.ts";
import { messageVisibleSql } from "./instanceSchema.generated.mjs";
import { sourceVisible } from "./messageVisibility.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Every file a test below scans — the last source test checks its list covers each of them. */
const scanned = new Set<string>();
/** Stripped, with its END proven present: the raw file's last lines (≥ 40 characters) must close the stripped
 *  text, so a stripper or a read that lost the tail fails here instead of a doesNotMatch below
 *  going green over the hole. */
const read = (p: string) => {
  scanned.add(p);
  const raw = readFileSync(join(webRoot, p), "utf8");
  const src = stripComments(raw);
  const lines = raw.trimEnd().split("\n");
  let tail = "";
  for (let i = lines.length - 1; i >= 0 && tail.trim().length < 40; i--) tail = lines.slice(i).join("\n");
  assert.ok(tail.trim().length >= 40 && src.trimEnd().endsWith(tail), `${p}: the scan lost the end of the file`);
  return src;
};

test("the rule is one text, and refuses an alias that is not one", () => {
  assert.equal(messageVisibleSql("m"), "NOT m.is_deleted");
  assert.throws(() => messageVisibleSql("m; DROP TABLE x"), /bad SQL alias/);
});

test("pins: POST and the auto-pin snapshot only a VISIBLE message, from either table", () => {
  for (const f of ["app/api/chat/pin/route.ts", "app/api/chat/vote/route.ts"]) {
    const src = read(f);
    assert.match(src, /FROM site\.chat_messages m[\s\S]{0,120}WHERE m\.id = \$1 AND \$\{messageVisibleSql\("m"\)\}/, `${f}: a deleted site message can be pinned`);
    assert.match(src, /FROM stream\.chat_log cl\s+WHERE cl\.id = \$1 AND cl\.platform = \$2 AND \$\{messageVisibleSql\("cl"\)\}/, `${f}: a deleted platform line can be pinned`);
  }
});

test("pins: GET unpins and announces a pin whose message is no longer visible, before serving it", () => {
  const src = read("app/api/chat/pin/route.ts");
  const get = src.slice(src.indexOf("export async function GET"));
  const check = get.indexOf("sourceVisible(row.platform, Number(row.message_id)");
  assert.ok(check > 0 && check < get.indexOf("withAuthor(toClient(row))"), "a pin is served before its source is re-checked");
  assert.match(get, /UPDATE site\.pinned_messages SET active = FALSE[\s\S]{0,120}await broadcastPin\(null\);\s*return Response\.json\(\{ pin: null \}\);/);
});

test("a reply quotes only a visible message — and quotes nothing otherwise, whatever the client sent", () => {
  const src = read("app/api/chat/send/route.ts");
  assert.match(src, /SELECT m\.message FROM site\.chat_messages m WHERE m\.id = \$1 AND \$\{messageVisibleSql\("m"\)\}/);
  assert.match(src, /quoteText = q\[0\] \? q\[0\]\.message\.slice\(0, 100\) : null;/);
});

test("history serves deleted rows to moderators only, through the rule", () => {
  const src = read("app/api/chat/history/route.ts");
  assert.match(src, /AND \(\$\{messageVisibleSql\("cl"\)\} OR \$2\)/);
  assert.match(src, /AND \(\$\{messageVisibleSql\("m"\)\} OR \$2\)/);
});

test("boards: the faces that SHOW message text (top messages, top emotes) read only visible rows", () => {
  const src = read("app/lib/boards.ts");
  const face = src.slice(src.indexOf("messages: `WITH"), src.indexOf("`,", src.indexOf("messages: `WITH")));
  assert.match(face, /LEFT JOIN site\.chat_messages m ON[^\n]*\$\{messageVisibleSql\("m"\)\}/, "top messages can show a deleted site message");
  assert.match(face, /LEFT JOIN stream\.chat_log cl ON[^\n]*\$\{messageVisibleSql\("cl"\)\}/, "top messages can show a deleted platform line");
  assert.match(src, /WHERE m\.emotes IS NOT NULL AND \$\{messageVisibleSql\("m"\)\}/, "top emotes read deleted site messages");
  assert.match(src, /WHERE cl\.emotes IS NOT NULL[^\n]*\$\{messageVisibleSql\("cl"\)\}/, "top emotes read deleted platform lines");
  assert.doesNotMatch(src, /NOT (m|cl)\.is_deleted/, "a board decides visibility on its own");
});

test("no public route re-implements the rule: every chat-content read outside mod routes uses messageVisibleSql", () => {
  const paths = ["app/api/chat/pin/route.ts", "app/api/chat/vote/route.ts", "app/api/chat/send/route.ts", "app/api/chat/history/route.ts", "app/lib/boards.ts", "app/lib/messageVisibility.ts"];
  // Anchor: the list is not empty, and it names every public reader the tests above pin one by one.
  const before = [...scanned];
  assert.ok(before.length >= 5, "the per-reader tests above scanned nothing — this sweep would be vacuous");
  for (const f of before) assert.ok(paths.includes(f), `${f} is pinned above but missing from this sweep`);
  for (const p of paths) {
    const src = read(p);
    assert.match(src, /messageVisibleSql/, `${p} no longer uses the shared rule`);
    assert.doesNotMatch(src, /\bNOT\s+(m|cl)\.is_deleted\b|is_deleted\s*=\s*false/, `${p} decides visibility on its own`);
  }
});

test("sourceVisible on a real Postgres: a deleted site message and a deleted platform line are not visible", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) { assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI"); t.skip("SQL_PARSE_DATABASE_URL not set"); return; }
  const db = new Client({ connectionString: url });
  await db.connect();
  const who = "@visibility-test:x";
  try {
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'V') ON CONFLICT DO NOTHING`, [who]);
    await db.query(`INSERT INTO stream.users (id, name) VALUES ('vistestcanon', 'vis') ON CONFLICT DO NOTHING`);
    const live = (await db.query(`INSERT INTO site.chat_messages (matrix_id, message) VALUES ($1, 'shown') RETURNING id`, [who])).rows[0].id;
    const gone = (await db.query(`INSERT INTO site.chat_messages (matrix_id, message, is_deleted) VALUES ($1, 'evidence', true) RETURNING id`, [who])).rows[0].id;
    const plat = (await db.query(`INSERT INTO stream.chat_log (user_id, platform, username, message, is_deleted) VALUES ('vistestcanon', 'twitch', 'vis', 'deleted line', true) RETURNING id`)).rows[0].id;
    const q = (sql: string, params: unknown[]) => db.query(sql, params);
    assert.equal(await sourceVisible("native", Number(live), q), true);
    assert.equal(await sourceVisible("native", Number(gone), q), false, "kept evidence is publicly visible");
    assert.equal(await sourceVisible("twitch", Number(plat), q), false, "a deleted platform line is publicly visible");
    assert.equal(await sourceVisible("twitch", 999999999, q), false);
  } finally {
    await db.query(`DELETE FROM site.chat_messages WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM stream.chat_log WHERE user_id = 'vistestcanon'`);
    await db.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    await db.query(`DELETE FROM stream.users WHERE id = 'vistestcanon'`);
    await db.end();
  }
});
