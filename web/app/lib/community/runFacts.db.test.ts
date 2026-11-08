// The doctor's run-log facts over real tables: the jsonb counting a fake cannot check. Every write is
// inside a transaction that is rolled back.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/cmty_scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/cmty_scratch node --test app/lib/community/runFacts.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { communityRunFacts } from "./runFacts.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";

test("the newest run and the newest finished one, counted from the stored entries", async (t) => {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM site.community_runs");
    assert.deepEqual(await communityRunFacts(db, { timeZone: null }), { latest: null, lastFinished: null });
    // An apply that put two things back (and made one), with a note; then a check that found one
    // thing and noted another; then a run still going.
    const ins = `INSERT INTO site.community_runs (mode, started_at, finished_at, ok, drift, applied, error) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`;
    await db.query(ins, ["apply", "2026-10-09T23:00:00Z", "2026-10-09T23:01:00Z", true,
      JSON.stringify([{ op: "warn", code: "bridge_accounts_unknown", said: "x" }]),
      JSON.stringify([{ op: "setTopic", putBack: true, said: "a" }, { op: "rename", putBack: true, said: "b" }, { op: "createRoom", said: "c" }]), null]);
    await db.query(ins, ["report", "2026-10-09T23:50:00Z", "2026-10-09T23:51:00Z", false,
      JSON.stringify([{ op: "setTopic", putBack: true, said: "a" }, { op: "warn", code: "not_in_panel", said: "n" }, { said: "no op" }]), "[]", "the room !secret:example.test refused"]);
    let f = await communityRunFacts(db, { timeZone: "Europe/Berlin" });
    assert.deepEqual(f?.lastFinished, { mode: "report", startedAt: "2026-10-09T23:50:00.000Z", finishedAt: "2026-10-09T23:51:00.000Z", ok: false, putBack: 0, left: 2, warns: { not_in_panel: 1 }, clock: "01:51" });
    assert.deepEqual(f?.latest, f?.lastFinished);
    assert.ok(!JSON.stringify(f).includes("secret"), "the run's error text never reaches the facts");
    await db.query(ins, ["apply", "2026-10-10T00:05:00Z", null, null, null, null, null]);
    f = await communityRunFacts(db, { timeZone: null });
    assert.deepEqual(f?.latest, { mode: "apply", startedAt: "2026-10-10T00:05:00.000Z", finishedAt: null, ok: null, putBack: 0, left: 0, warns: {}, clock: "00:05 UTC" });
    assert.equal(f?.lastFinished?.mode, "report");
    // The apply's put-backs count only entries marked so; its note is not "left".
    await db.query(`DELETE FROM site.community_runs WHERE mode = 'report' OR finished_at IS NULL`);
    f = await communityRunFacts(db, { timeZone: null });
    assert.equal(f?.lastFinished?.putBack, 2);
    assert.equal(f?.lastFinished?.left, 0);
    assert.deepEqual(f?.lastFinished?.warns, { bridge_accounts_unknown: 1 }, "warns counted by code");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
