// Automod on a site message (the release contract):
//   • exemptions are server-side facts only;
//   • the hold sits after the link gate and BEFORE the redaction gates and any debit, so a held
//     paid message is never charged;
//   • 'ai' is releasable on the native branch, and an Allow on an AI hold re-posts through
//     /chat/native (without it, Allow marks the row and the message never appears).
// Run: node --test app/lib/automodHold.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./testSource.ts";
import { Client } from "pg";
import { automodExempt } from "./automodHold.ts";
import { AUTOMOD_QUEUE_SQL, AUTOMOD_QUEUE_PER_SENDER } from "./automodQueueSql.ts";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => stripComments(readFileSync(join(webRoot, p), "utf8"));

test("exemptions: staff/mods/the bot, a wholly encrypted message, supporters only when asked — never anything the sender typed", () => {
  const base = { isPrivileged: false, wholeRedacted: false, isSupporter: false, skipSupporters: false };
  assert.equal(automodExempt(base), false);
  assert.equal(automodExempt({ ...base, isPrivileged: true }), true);
  assert.equal(automodExempt({ ...base, wholeRedacted: true }), true);
  assert.equal(automodExempt({ ...base, isSupporter: true }), false, "a supporter is checked unless the install says otherwise");
  assert.equal(automodExempt({ ...base, isSupporter: true, skipSupporters: true }), true);
  assert.equal(Object.keys(base).length, 4, "the exemption takes exactly these four server-side facts");
});

test("the hold's place in the send route: after the filters, the redaction gates and the commands it handles; before any debit", () => {
  const src = read("app/api/chat/send/route.ts");
  const hold = src.indexOf("askAutomod(");
  assert.ok(hold > 0, "the send route no longer asks automod");
  assert.ok(src.indexOf("holdLinkHit(") < hold, "automod runs before the link gate");
  assert.ok(src.indexOf("if (red.redacted) {") < hold, "automod runs before the redaction gates");
  assert.ok(src.indexOf("askPronounCommand(") < hold, "automod runs before the commands this route handles");
  assert.ok(hold < src.indexOf("debitCoins("), "automod runs after a debit — a held paid message would be charged");
  assert.ok(hold < src.indexOf("streamApiFetch(`/chat/native`"), "automod runs after the message is stored");
  const call = src.slice(src.lastIndexOf("automodExempt({", hold), hold);
  assert.match(call, /isPrivileged, wholeRedacted: wholeRedact,/);
  assert.match(call, /isSupporter: !!tier, skipSupporters: skipSupporters\(\)/);
  assert.doesNotMatch(call, /body\.|message|startsWith|Command/, "an exemption is read from what the sender sent");
  assert.match(src.slice(hold, hold + 400), /text: red\.redacted \? red\.publicText : message/, "hidden words would be sent to the provider");
  assert.match(src.slice(hold, hold + 800), /verdict\.refused[\s\S]{0,200}status: 429/, "a sender over the pending cap must be refused, not delivered");
  assert.match(src, /nothing was charged/);
  assert.match(src, /export async function POST/, "vacuity: the route was read to its end");
});

test("only staff resolve a hold: the resolve route checks same-origin, then requireMod, before anything", () => {
  const resolve = read("app/api/mod/automod/resolve/route.ts");
  const body = resolve.slice(resolve.indexOf("export async function POST"));
  const first = body.split("\n").slice(1).filter((l) => l.trim()).slice(0, 2).join("\n");
  assert.match(first, /if \(!sameOriginRequest\(req\.headers\)\) return/);
  assert.match(first, /const mod = await requireMod\(\);/);
  assert.match(read("app/api/mod/marks/[id]/clear/route.ts"), /sameOriginRequest[\s\S]*requireMod/, "clearing a mark is not mod-only");
  assert.match(read("app/api/chat/held/[id]/route.ts"), /WHERE id = \$1 AND matrix_id = \$2/, "the sender's own view is read-only and own-only");
});

test("release contract: 'ai' is releasable on the native branch, and Allow re-posts through /chat/native", () => {
  const resolve = read("app/api/mod/automod/resolve/route.ts");
  const t = /RELEASABLE = isNative\s*\?\s*\[([^\]]*)\]\s*:\s*\[([^\]]*)\]/.exec(resolve);
  assert.ok(t, "the RELEASABLE ternary is gone");
  assert.match(t![1] ?? "", /"ai"/, "an AI hold Allowed would be marked allowed and never delivered");
  assert.doesNotMatch(t![2] ?? "", /"ai"/, "a platform AI row is flagged (already public) — there is nothing to release");
  assert.match(resolve, /const released = isNative\s*\?\s*await streamApiFetch\("\/chat\/native"/);
  assert.match(resolve, /status = 'flagged' AND source = 'ai'/, "a flagged AI row cannot be dismissed");
});

test("the hold's sender-side answer is the shared 202 shape the pending line follows", () => {
  const helper = read("app/lib/automodHold.ts");
  assert.match(helper, /held: true, rowId: j\.rowId as number/);
  assert.match(helper, /return \{ held: false \};\n  \}\n\}\s*$/, "vacuity: the helper was read to its end — and every failure delivers");
});

test("the queue is fair on a real Postgres: one sender flooding cannot push others out of sight, and nothing is overwritten", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();
  const clean = () => db.query(`DELETE FROM site.automod_held WHERE matrix_id LIKE '@aqfair%'`);
  await clean();
  try {
    await db.query(`INSERT INTO site.automod_held (source, status, platform, matrix_id, text, held_at)
      VALUES ('ai', 'pending', 'native', '@aqfair-victim:x', 'victim held', now() - interval '1 minute')`);
    for (let i = 0; i < 80; i++) {
      await db.query(`INSERT INTO site.automod_held (source, status, platform, matrix_id, text) VALUES ('ai', 'pending', 'native', '@aqfair-flood:x', $1)`, [`flood ${i}`]);
    }
    const { rows } = await db.query(AUTOMOD_QUEUE_SQL);
    const mine = rows.filter((r) => String(r.matrix_id).startsWith("@aqfair"));
    assert.ok(mine.some((r) => r.text === "victim held"), "the flooder pushed the other sender's hold out of the queue");
    assert.equal(mine.filter((r) => r.matrix_id === "@aqfair-flood:x").length, AUTOMOD_QUEUE_PER_SENDER);
    const victim = await db.query(`SELECT text, status FROM site.automod_held WHERE matrix_id = '@aqfair-victim:x'`);
    assert.deepEqual(victim.rows, [{ text: "victim held", status: "pending" }], "the other sender's row changed");
  } finally {
    await clean();
    await db.end();
  }
});
