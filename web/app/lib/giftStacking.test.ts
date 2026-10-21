// A gift to someone on a PAID sub must start when their paid period ends — through ANY service
// that counts — and a community gift never picks someone who already pays (owner review D,
// 2026-10-21: both read the legacy Stripe-only row, so a PayPal subscriber was picked as a
// community recipient, and a gift to one ran alongside their paid month instead of after it).
//
// The scan pins that giftServer.ts reads the records' one entitlement fragment; the SQL it uses is
// then RUN against a replayed database (SQL_PARSE_DATABASE_URL, the subscriptions tests' setup).
// Run: SQL_PARSE_DATABASE_URL=… node --test app/lib/giftStacking.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { stripComments } from "./testSource.ts";
import { columnEntitledSql, paidThroughSql } from "./subscriptions/entitlement.ts";
import { writeTransition } from "./subscriptions/state.ts";
import type { Observation, Provider } from "./subscriptions/types.ts";

const src = readFileSync(join(import.meta.dirname, "giftServer.ts"), "utf8");

test("giftServer reads the records' fragment for both questions, and never the legacy row", () => {
  assert.match(src, /setInterval\(\(\) => void run\(\), 60 \* 60 \* 1000\); \/\/ hourly\s*\}\s*$/, "END of giftServer.ts not read");
  const s = stripComments(src);
  assert.match(s, /GREATEST\(\s*now\(\),\s*COALESCE\(\(SELECT MAX\(expires_at\) FROM site\.gift_subscriptions WHERE recipient_matrix_id = \$3\), now\(\)\),\s*COALESCE\(\$\{paidThroughSql\("\$3", "\$7"\)\}, now\(\)\)\s*\) \+ make_interval\(months => \$4\)/,
    "the gift clock starts at the LATEST of now, the last gift's end and the paid period's end");
  assert.match(s, /AND NOT \$\{columnEntitledSql\("u\.matrix_id", "\$5"\)\}/, "a community gift skips anyone a record entitles");
  assert.equal([...s.matchAll(/subscriptionSources\(\)/g)].length, 2, "both queries pass the sources that count");
  assert.doesNotMatch(s, /site\.subscriptions\b/, "the legacy one-row table is not read for a gift");
});

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const unsafe = !DB_URL || DB_URL === process.env.DATABASE_URL || !/@(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(DB_URL);
const skip = unsafe ? (process.env.CI ? false : "SQL_PARSE_DATABASE_URL unset or unsafe") : false;

test("attack: a PayPal subscriber is not picked as a community recipient, and their gift starts after their paid month", { skip }, async () => {
  assert.ok(!unsafe, "SQL_PARSE_DATABASE_URL must point at a local throwaway database in CI");
  const pool = new Pool({ connectionString: DB_URL, max: 2 });
  const RUN = `gift${process.pid}x${Date.now().toString(36)}`;
  const SOURCES: Provider[] = ["stripe", "paypal"];
  const who = `@${RUN}:site.test`;
  const end = new Date(Date.now() + 20 * 86_400_000);
  try {
    await pool.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [who]);
    const c = await pool.connect();
    const obs: Observation = { provider: "paypal", externalId: `I-${RUN}`, tier: "supporter", status: "active", providerStatus: "ACTIVE",
      renews: true, periodEnd: end, accessUntil: new Date(end.getTime() + 7 * 86_400_000), observedAt: new Date() };
    try { await c.query("BEGIN"); await writeTransition(c, { via: "webhook", viewer: who, observations: [obs], sources: SOURCES }); await c.query("COMMIT"); }
    finally { c.release(); }
    const paid = (await pool.query(`SELECT ${paidThroughSql("$1", "$2")} AS t`, [who, SOURCES])).rows[0].t as Date;
    assert.equal(new Date(paid).getTime(), end.getTime(), "the gift starts at the end of the paid month");
    const picked = (await pool.query(`SELECT u.matrix_id FROM site.users u WHERE u.matrix_id = $1 AND NOT ${columnEntitledSql("u.matrix_id", "$2")}`, [who, SOURCES])).rows;
    assert.deepEqual(picked, [], "a PayPal subscriber is not a community-gift recipient");
    // PayPal switched off: they no longer count, for either question.
    assert.equal((await pool.query(`SELECT ${paidThroughSql("$1", "$2")} AS t`, [who, ["stripe"]])).rows[0].t, null);
  } finally {
    await pool.query(`DELETE FROM site.subscription_records WHERE external_id = $1`, [`I-${RUN}`]);
    await pool.query(`DELETE FROM site.users WHERE matrix_id = $1`, [who]);
    await pool.end();
  }
});
