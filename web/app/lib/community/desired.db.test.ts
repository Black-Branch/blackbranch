// The community's desired state against a real Postgres (v165). A mock pool would accept any SQL
// and any column name; this reads the tables the migration actually made.
//
// Every write here is either inside a transaction that is rolled back, or a fixture named with the
// cmty_test_ prefix that is deleted before and after.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/cmty_scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/cmty_scratch node --test app/lib/community/desired.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { readDesired, type RoleRow } from "./desired.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const PREFIX = "cmty_test_";

const LADDER: Array<Pick<RoleRow, "key" | "level" | "builtin">> = [
  { key: "admin", level: 100, builtin: true },
  { key: "staff", level: 75, builtin: true },
  { key: "mod", level: 50, builtin: true },
  { key: "bot", level: 50, builtin: true },
  { key: "supporter", level: 10, builtin: true },
  { key: "member", level: 0, builtin: true },
  { key: "timeout", level: -1, builtin: true },
];

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

const clean = (db: Client) =>
  db.query(`DELETE FROM site.community_rooms WHERE name LIKE '${PREFIX}%';
            DELETE FROM site.community_spaces WHERE name LIKE '${PREFIX}%';`);

function assertLadder(roles: RoleRow[], label: string) {
  assert.deepEqual(roles.map(({ key, level, builtin }) => ({ key, level, builtin })), LADDER, `${label}: not the ladder in level order`);
  const keys = roles.map((r) => r.orderKey);
  assert.deepEqual([...keys].sort(), keys, `${label}: order keys do not sort in ladder order`);
  assert.equal(new Set(keys).size, keys.length, `${label}: two roles share an order key`);
  assert.ok(roles.every((r) => typeof r.label === "string" && r.label.length > 0), `${label}: a role has no label`);
}

test("readDesired returns seeded roles in level order and empty spaces/rooms on a fresh schema", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await clean(db);
    const state = await readDesired(db);
    assertLadder(state.roles, "seeded");
    assert.deepEqual(state.spaces, [], "a fresh schema holds no spaces");
    assert.deepEqual(state.rooms, [], "a fresh schema holds no rooms");
  } finally {
    // end() even when the cleanup throws: an open socket hangs the run instead of failing it.
    await clean(db).finally(() => db.end());
  }
});

test("readDesired maps spaces and rooms to the typed rows, in order-key order", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await clean(db);
    const hub = await db.query<{ id: number }>(
      `INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id)
       VALUES ('hub', '${PREFIX}hub', 'a0', '!${PREFIX}hub:example.test') RETURNING id`);
    const hubId = hub.rows[0]?.id;
    const gate = await db.query<{ id: number }>(
      `INSERT INTO site.community_spaces (parent_id, kind, name, order_key, gate_tier)
       VALUES ($1, 'gate', '${PREFIX}supporters', 'a1', 'supporter') RETURNING id`, [hubId]);
    // Inserted out of order, and with an uppercase key that a locale collation would sort after
    // lowercase: Matrix compares order by code point, so must the read.
    await db.query(
      `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule, retention_days, encrypted, published)
       VALUES ($1, 'text', '${PREFIX}second', 'a0a', 'mods', 'mods', NULL, true, false),
              ($1, 'announcement', '${PREFIX}first', 'a0Z', 'everyone', 'mods', 30, false, true),
              ($1, 'forum', '${PREFIX}zeroth', 'a0', 'everyone', 'everyone', 180, false, true)`, [hubId]);
    const state = await readDesired(db);
    const spaces = state.spaces.filter((s) => s.name.startsWith(PREFIX));
    assert.deepEqual(spaces, [
      { id: hubId, parentId: null, kind: "hub", name: `${PREFIX}hub`, topic: null, avatarMxc: null, bannerMxc: null, orderKey: "a0",
        matrixRoomId: `!${PREFIX}hub:example.test`, gateTier: null },
      { id: gate.rows[0]?.id, parentId: hubId, kind: "gate", name: `${PREFIX}supporters`, topic: null, avatarMxc: null, bannerMxc: null,
        orderKey: "a1", matrixRoomId: null, gateTier: "supporter" },
    ]);
    const rooms = state.rooms.filter((r) => r.spaceId === hubId);
    assert.deepEqual(rooms.map((r) => r.name), [`${PREFIX}zeroth`, `${PREFIX}first`, `${PREFIX}second`]);
    assert.deepEqual(rooms[2], {
      id: rooms[2]?.id, spaceId: hubId, kind: "text", name: `${PREFIX}second`, topic: null, avatarMxc: null,
      orderKey: "a0a", see: "mods", post: "mods", retentionDays: null, encrypted: true, published: false,
      archived: false, matrixRoomId: null, discordChannelId: null,
    });
    assert.equal(typeof rooms[0]?.id, "number");
  } finally {
    // end() even when the cleanup throws: an open socket hangs the run instead of failing it.
    await clean(db).finally(() => db.end());
  }
});

test("the tables refuse what the model refuses: an unknown see rule, a zero retention, a duplicate Matrix room", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    const hub = await db.query<{ id: number }>(
      `INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id)
       VALUES ('hub', '${PREFIX}hub', 'a0', '!${PREFIX}dup:example.test') RETURNING id`);
    const tries: Array<[string, string]> = [
      ["see_rule 'nobody'", `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule) VALUES (${hub.rows[0]?.id}, 'text', '${PREFIX}x', 'a0', 'nobody', 'everyone')`],
      ["post_rule 'invited'", `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule) VALUES (${hub.rows[0]?.id}, 'text', '${PREFIX}x', 'a0', 'everyone', 'invited')`],
      ["retention 0", `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule, retention_days) VALUES (${hub.rows[0]?.id}, 'text', '${PREFIX}x', 'a0', 'everyone', 'everyone', 0)`],
      ["kind 'voice'", `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule) VALUES (${hub.rows[0]?.id}, 'voice', '${PREFIX}x', 'a0', 'everyone', 'everyone')`],
      ["duplicate matrix_room_id", `INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id) VALUES ('category', '${PREFIX}c', 'a1', '!${PREFIX}dup:example.test')`],
    ];
    for (const [what, sql] of tries) {
      await db.query("SAVEPOINT s");
      await assert.rejects(db.query(sql), `${what} was accepted`);
      await db.query("ROLLBACK TO SAVEPOINT s");
    }
    // Every see rule and post rule the model has, the table takes.
    for (const see of ["everyone", "supporters", "mods", "staff", "invited"]) {
      for (const post of ["everyone", "supporters", "staff", "mods"]) {
        await db.query(
          `INSERT INTO site.community_rooms (space_id, kind, name, order_key, see_rule, post_rule) VALUES ($1, 'text', $2, 'a0', $3, $4)`,
          [hub.rows[0]?.id, `${PREFIX}${see}-${post}`, see, post]);
      }
    }
    const users = await db.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'site' AND table_name = 'users' AND column_name = 'is_staff'`);
    assert.deepEqual(users.rows, [{ column_default: "false", is_nullable: "NO" }], "site.users.is_staff is not a NOT NULL false flag");
  } finally {
    await db.query("ROLLBACK").finally(() => db.end());
  }
});

test("restart: a new connection reads the same desired state", async (t) => {
  const first = await connect(t);
  if (!first) return;
  // `first` keeps the lock until the second connection has read.
  const second = new Client({ connectionString: DB_URL });
  try {
    const before = await readDesired(first);
    await second.connect();
    assert.deepEqual(await readDesired(second), before);
  } finally {
    await second.end().finally(() => first.end());
  }
});

test("retry: an emptied role ladder is filled once, and a second read adds nothing", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    // A database that started from the fresh-install baseline holds no roles (the seed carries
    // singleton rows only); readDesired fills the default ladder. Rolled back: nothing persists.
    await db.query("BEGIN");
    await db.query("DELETE FROM site.community_roles");
    assertLadder((await readDesired(db)).roles, "filled");
    assertLadder((await readDesired(db)).roles, "read again");
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM site.community_roles");
    assert.equal(n.rows[0]?.n, LADDER.length);
  } finally {
    await db.query("ROLLBACK").finally(() => db.end());
  }
});

test("retry: applying v165 a second time changes nothing", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    const sql = readFileSync(new URL("../../../../migrations/migrate-v165.sql", import.meta.url), "utf8");
    assert.match(sql, /VALUES \(165,/, "vacuity anchor: this is not the v165 file");
    const before = await readDesired(db);
    await db.query(sql);
    assert.deepEqual(await readDesired(db), before);
  } finally {
    await db.end();
  }
});

test("banner restart: a banner the panel saved is read back by a new connection, ready for the feed (v174)", async (t) => {
  const db = await connect(t);
  if (!db) return;
  const MXC = "mxc://example.test/banner1";
  try {
    await clean(db);
    // The panel's statement (communityAdmin.ts saveBanner) on a hub row of this test's own.
    await db.query(`INSERT INTO site.community_spaces (kind, name, order_key) VALUES ('hub', '${PREFIX}hub', 'a0')`);
    const saved = await db.query(`UPDATE site.community_spaces SET banner_mxc = $1, updated_at = now() WHERE kind = 'hub' AND name = '${PREFIX}hub' RETURNING id`, [MXC]);
    assert.equal(saved.rows.length, 1);
    const second = new Client({ connectionString: DB_URL });
    await second.connect();
    try {
      const hub = (await readDesired(second)).spaces.find((s) => s.name === `${PREFIX}hub`);
      assert.equal(hub?.bannerMxc, MXC);
      assert.equal(hub?.avatarMxc, null, "the icon is its own column");
    } finally {
      await second.end();
    }
    // Applying v174 again keeps the banner (ADD COLUMN IF NOT EXISTS).
    const sql = readFileSync(new URL("../../../../migrations/migrate-v174.sql", import.meta.url), "utf8");
    assert.match(sql, /VALUES \(174,/, "vacuity anchor: this is the v174 file");
    await db.query(sql);
    assert.equal((await readDesired(db)).spaces.find((s) => s.name === `${PREFIX}hub`)?.bannerMxc, MXC);
  } finally {
    await clean(db).finally(() => db.end());
  }
});
