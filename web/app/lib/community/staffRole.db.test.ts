// The Staff role against a real Postgres: the write and the list run on the real tables (a mock
// accepts any SQL), and what the list shows after a save is what the reconciler's feed reads.
//
// The database is SHARED with the other suites: everything here is one transaction, rolled back.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/scratch node --test app/lib/community/staffRole.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { setStaffResponse, staffListResponse, type StaffDeps, type StaffQuery } from "./staffRole.ts";
import { buildDesiredFeed, readCommunityLadder, type FeedEnv } from "./desiredServer.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const id = (name: string) => `@cmtystaff-${name}:example.test`;

const ENV: FeedEnv = {
  serverName: "example.test", serviceUserId: id("service"), readerUserId: null, hubRoomId: null,
  streamerId: id("streamer"), botIds: [], sources: ["stripe"], putBack: true, retentionCapDays: 365, bridgeAccounts: [],
};

const post = (body: unknown) => new Request("http://x/api/admin/staff", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("staff restart: who is Staff lives in the database, so a fresh read lists them and the feed puts them at 75", async (t) => {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id, display_name) VALUES ($1, 'Sam'), ($2, 'Mo'), ($3, 'Gone')`, [id("sam"), id("mo"), id("gone")]);
    await db.query(`UPDATE site.users SET is_mod = true WHERE matrix_id = $1`, [id("mo")]);
    await db.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [id("gone")]);
    const query: StaffQuery = (sql, params) => db.query(sql, params);
    const asks: number[] = [];
    const deps: StaffDeps = {
      query,
      log: async (action, target, by) => {
        await db.query(`INSERT INTO site.mod_log (action, target_id, performed_by) VALUES ($1, $2, $3)`, [action, target, by]);
      },
      reconcile: async () => { asks.push(1); return true; },
    };

    for (const who of ["sam", "mo"]) {
      const r = await setStaffResponse(post({ targetId: id(who), grant: true }), id("streamer"), deps);
      assert.equal(r.status, 200, await r.clone().text());
    }
    const gone = await setStaffResponse(post({ targetId: id("gone"), grant: true }), id("streamer"), deps);
    assert.equal(gone.status, 404, "a deleted account is not made Staff");
    assert.equal(asks.length, 2);

    // A restarted process holds nothing: everything below is a fresh read of the rows.
    const list = (await (await staffListResponse(query)).json()) as { staff: { matrixId: string; since: string | null }[] };
    const ours = list.staff.filter((s) => s.matrixId.startsWith("@cmtystaff-"));
    assert.deepEqual(ours.map((s) => s.matrixId), [id("mo"), id("sam")], "ordered by name, the deleted account absent");
    assert.ok(ours.every((s) => s.since !== null), "since: the staff_granted log line");

    const flags = (await db.query(`SELECT matrix_id, is_staff, is_mod FROM site.users WHERE matrix_id = $1`, [id("mo")])).rows[0];
    assert.deepEqual(flags, { matrix_id: id("mo"), is_staff: true, is_mod: true }, "a mod made Staff stays a mod");

    const feed = await buildDesiredFeed(db, ENV);
    const level = (who: string) => feed.people.find((p) => p.userId === id(who))?.level;
    assert.equal(level("sam"), 75);
    assert.equal(level("mo"), 75, "both flags: the ladder gives the higher");
    const ladder = await readCommunityLadder(db, ENV);
    assert.ok(ladder.staffIds.includes(id("sam")) && ladder.staffIds.includes(id("mo")));

    const off = await setStaffResponse(post({ targetId: id("mo"), grant: false }), id("streamer"), deps);
    assert.deepEqual(await off.json(), { ok: true, changed: true, requested: true });
    const after = await buildDesiredFeed(db, ENV);
    assert.equal(after.people.find((p) => p.userId === id("mo"))?.level, 50, "removed from Staff, still a Mod");
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
});
