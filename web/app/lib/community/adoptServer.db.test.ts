// The adopt route's SQL against a real Postgres: the column names, the shared sibling order, the
// unique room ids and the CHECKs the fake in app/api/internal/community/adopt.test.ts cannot see.
// Every write is inside a transaction that is rolled back.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/cmty_scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/cmty_scratch node --test app/lib/community/adoptServer.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { adoptPostResponse } from "./adoptServer.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const SECRET = "adopt-db-test-secret";
const rid = (x: string) => `!cmtyadopt-${x}:example.test`;

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return null;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  // node --test runs files at once on one database: this file and adoptServer.db.test.ts / desired.db.test.ts
  // both commit and wipe community rows, so each test holds this lock for its connection's life.
  await db.query("SELECT pg_advisory_lock(165165)");
  return db;
}

const post = (db: Client, body: unknown) => adoptPostResponse(
  new Request("http://site.test/api/internal/community/adopt", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${SECRET}` } }),
  { db, secret: SECRET, log: { error: () => {} } },
);
const profile = { topic: null, avatarMxc: null, orderKey: null };
const roomRow = (name: string, over: object = {}) => ({ kind: "text", name, ...profile, see: "everyone", post: "everyone", retentionDays: null,
  encrypted: false, published: false, archived: false, matrixRoomId: rid(name), discordChannelId: null, ...over });

test("adopt over real tables: the hub, a category and rooms, each placed after its siblings; a retry; a tombstone followed", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    // An install whose panel is empty: the first adopt brings the hub itself.
    await db.query("DELETE FROM site.community_rooms");
    await db.query("DELETE FROM site.community_spaces");
    const hub = await post(db, { op: "adoptRow", table: "spaces", matrixRoomId: rid("hub"), parentRoomId: null,
      row: { kind: "hub", name: "Example", ...profile, matrixRoomId: rid("hub"), gateTier: null } });
    assert.equal(hub.status, 200, await hub.clone().text());
    const hubId = ((await hub.json()) as { id: number }).id;

    const lobby = await post(db, { op: "adoptRow", table: "rooms", matrixRoomId: rid("lobby"), parentRoomId: rid("hub"),
      row: roomRow("lobby", { see: "supporters", post: "mods", retentionDays: 30, encrypted: true }) });
    assert.equal(lobby.status, 200, await lobby.clone().text());
    const games = await post(db, { op: "adoptRow", table: "spaces", matrixRoomId: rid("games"), parentRoomId: rid("hub"),
      row: { kind: "category", name: "Games", ...profile, orderKey: "a5", matrixRoomId: rid("games"), gateTier: null } });
    assert.equal(games.status, 200);
    const chess = await post(db, { op: "adoptRow", table: "rooms", matrixRoomId: rid("chess"), parentRoomId: rid("games"), row: roomRow("chess", { kind: "forum" }) });
    assert.equal(chess.status, 200);
    const late = await post(db, { op: "adoptRow", table: "rooms", matrixRoomId: rid("late"), parentRoomId: rid("hub"), row: roomRow("late") });
    assert.equal(late.status, 200);

    const spaces = (await db.query(`SELECT kind, name, parent_id, order_key, matrix_room_id FROM site.community_spaces ORDER BY id`)).rows;
    assert.deepEqual(spaces, [
      { kind: "hub", name: "Example", parent_id: null, order_key: "a0", matrix_room_id: rid("hub") },
      { kind: "category", name: "Games", parent_id: hubId, order_key: "a5", matrix_room_id: rid("games") },
    ]);
    const rooms = (await db.query(`SELECT name, kind, see_rule, post_rule, retention_days, encrypted, order_key, space_id FROM site.community_rooms ORDER BY id`)).rows;
    assert.deepEqual(rooms.map((r) => [r.name, r.kind, r.see_rule, r.post_rule, r.retention_days, r.encrypted, r.order_key]), [
      ["lobby", "text", "supporters", "mods", 30, true, "a0"],
      ["chess", "forum", "everyone", "everyone", null, false, "a0"],
      // After the category's a5: a room and a category share one order under the hub.
      ["late", "text", "everyone", "everyone", null, false, "a6"],
    ]);
    assert.equal(rooms[1]!.space_id, ((await games.json()) as { id: number }).id);

    // retry: the same row again answers the same id; nothing new.
    const lateId = ((await late.json()) as { id: number }).id;
    const again = await post(db, { op: "adoptRow", table: "rooms", matrixRoomId: rid("late"), parentRoomId: rid("hub"), row: roomRow("late") });
    assert.deepEqual(await again.json(), { ok: true, id: lateId });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.community_rooms`)).rows[0].n, 3);

    // A room upgraded in Element: the row follows the tombstone; the same op again is fine.
    const follow = { op: "followTombstone", table: "rooms", rowId: lateId, roomId: rid("late"), to: rid("late2"), label: "#late" };
    assert.equal((await post(db, follow)).status, 200);
    assert.equal((await post(db, follow)).status, 200);
    assert.equal((await db.query(`SELECT matrix_room_id FROM site.community_rooms WHERE id = $1`, [lateId])).rows[0].matrix_room_id, rid("late2"));
    // Following onto a room another row has: the unique id refuses it (409), the row stays. (The
    // savepoint only keeps this test's transaction usable after the refused statement.)
    await db.query("SAVEPOINT clash");
    const clash = await post(db, { ...follow, roomId: rid("late2"), to: rid("chess") });
    assert.equal(clash.status, 409);
    await db.query("ROLLBACK TO SAVEPOINT clash");
    assert.equal((await db.query(`SELECT matrix_room_id FROM site.community_rooms WHERE id = $1`, [lateId])).rows[0].matrix_room_id, rid("late2"));
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("the hub's import over real tables brings setup's channels with it; the setup rooms land first; a retry writes nothing twice", async (t) => {
  const db = await connect(t);
  if (!db) return;
  const setup = () => ({ channels: [{ kind: "announcement" as const, name: "announcements" }, { kind: "text" as const, name: "off-topic" }], retentionCapDays: 14 });
  const postSetup = (body: unknown) => adoptPostResponse(
    new Request("http://site.test/api/internal/community/adopt", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${SECRET}` } }),
    { db, secret: SECRET, log: { error: () => {} }, setup },
  );
  try {
    await db.query("BEGIN");
    await db.query("DELETE FROM site.community_rooms");
    await db.query("DELETE FROM site.community_spaces");
    const hubOp = { op: "adoptRow", table: "spaces", matrixRoomId: rid("hub"), parentRoomId: null,
      row: { kind: "hub", name: "Example", ...profile, matrixRoomId: rid("hub"), gateTier: null } };
    const hub = await postSetup(hubOp);
    assert.equal(hub.status, 200, await hub.clone().text());
    const hubId = ((await hub.json()) as { id: number }).id;
    const rooms = async () => (await db.query(`SELECT name, kind, see_rule, post_rule, retention_days, encrypted, published, archived, matrix_room_id, space_id, order_key
                                                FROM site.community_rooms ORDER BY order_key COLLATE "C"`)).rows;
    assert.deepEqual((await rooms()).map((r) => [r.name, r.kind, r.see_rule, r.post_rule, r.retention_days, r.encrypted, r.published, r.archived, r.matrix_room_id, r.space_id]), [
      ["announcements", "announcement", "everyone", "mods", null, false, true, false, null, hubId],
      // Chat keeps 30 days, within the cap: 14 here.
      ["off-topic", "text", "everyone", "everyone", 14, false, true, false, null, hubId],
    ]);
    // retry: the hub again answers its row; the channels are not written twice.
    assert.deepEqual(await (await postSetup(hubOp)).json(), { ok: true, id: hubId });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM site.community_rooms`)).rows[0].n, 2);
    // The bootstrap's two rooms, imported next with no order of their own, go before the two waiting.
    for (const [name, kind] of [["general", "text"], ["forum", "forum"]] as const) {
      const r = await postSetup({ op: "adoptRow", table: "rooms", matrixRoomId: rid(name), parentRoomId: rid("hub"), row: roomRow(name, { kind, published: true }) });
      assert.equal(r.status, 200, await r.clone().text());
    }
    assert.deepEqual((await rooms()).map((r) => r.name), ["general", "forum", "announcements", "off-topic"]);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
