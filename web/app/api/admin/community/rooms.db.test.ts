// The Community page's saves against a real Postgres (v165): every handler's SQL runs on the real
// tables (a mock pool accepts any SQL), a refused save leaves nothing behind, and what was saved is
// what readDesired (the reconciler's feed) reads.
//
// The database is SHARED with the other suites, which run at the same time and expect exactly the
// seven built-in roles and no rows but their own. So nothing here is ever committed: the whole test is
// ONE transaction that is rolled back, and each handler's own BEGIN / COMMIT / ROLLBACK becomes a
// savepoint inside it (the handlers' transaction shape is kept: a refused save rolls back to its
// savepoint). Row names carry the cmty_test_ prefix as well.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/scratch node --test app/api/admin/community/rooms.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { readDesired } from "../../../lib/community/desired.ts";
import {
  createRoomResponse, patchRoomResponse, archiveRoomResponse, deleteRoomResponse, createSpaceResponse, patchSpaceResponse,
  deleteSpaceResponse, createRoleResponse, patchRoleResponse, communityViewResponse, type CommunityDeps,
} from "../../../lib/community/communityAdmin.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const P = "cmty_test_r17_";

function skipUnlessDb(t: { skip: (m: string) => void }): boolean {
  if (DB_URL) return false;
  assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
  t.skip("SQL_PARSE_DATABASE_URL not set");
  return true;
}

/** A pool for the handlers that is the one open transaction: their BEGIN/COMMIT/ROLLBACK are savepoints. */
function insideOne(db: Client): CommunityDeps["pool"] {
  const query = ((sql: string, params?: unknown[]) => {
    const s = sql.trim();
    if (s === "BEGIN") return db.query("SAVEPOINT handler");
    if (s === "COMMIT") return db.query("RELEASE SAVEPOINT handler");
    if (s === "ROLLBACK") return db.query("ROLLBACK TO SAVEPOINT handler").then(() => db.query("RELEASE SAVEPOINT handler"));
    return db.query(sql, params);
  }) as CommunityDeps["pool"]["query"];
  return { query, connect: async () => ({ query, release: () => {} }) };
}

const req = (body: unknown, method = "POST") => new Request("http://x/", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ok = async (res: Response) => {
  const j = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(j));
  return j;
};

test("restart: what the routes saved is what a new reader reads (real Postgres, one rolled-back transaction)", async (t) => {
  if (skipUnlessDb(t)) return;
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  let asked = 0;
  const deps: CommunityDeps = {
    pool: insideOne(db), ask: async () => { asked++; return { ok: true, requestedAt: new Date().toISOString() }; },
    retentionCapDays: () => 365, log: { log: () => {}, error: () => {} },
  };
  try {
    await db.query("BEGIN");
    // A baseline-built database has no roles until the first read fills the ladder (in this transaction).
    await readDesired(db);
    const hub = (await db.query<{ id: number }>(`INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id)
      VALUES ('hub', '${P}hub', 'a0', '!${P}hub:example.test') RETURNING id`)).rows[0]!.id;
    const gate = (await db.query<{ id: number }>(`INSERT INTO site.community_spaces (parent_id, kind, name, order_key)
      VALUES ($1, 'gate', '${P}gate', 'a9') RETURNING id`, [hub])).rows[0]!.id;

    const talk = Number((await ok(await createSpaceResponse(req({ name: `${P}Talk`, parentId: hub }), deps))).id);
    const stream = Number((await ok(await createSpaceResponse(req({ name: `${P}Stream`, parentId: hub }), deps))).id);
    await ok(await patchSpaceResponse(req({ name: `${P}Live`, topic: "On air" }, "PATCH"), String(stream), deps));
    const room = (name: string, over = {}) => req({ spaceId: talk, kind: "text", name, see: "everyone", post: "everyone", retentionDays: 30, encrypted: false, ...over });
    const general = Number((await ok(await createRoomResponse(room(`${P}general`), deps))).id);
    const vip = Number((await ok(await createRoomResponse(room(`${P}vip`, { see: "supporters", encrypted: true, retentionDays: null }), deps))).id);
    const gone = Number((await ok(await createRoomResponse(room(`${P}gone`), deps))).id);
    await ok(await patchRoomResponse(req({ name: `${P}lobby`, spaceId: stream, orderKey: "a0" }, "PATCH"), String(general), deps));
    await ok(await archiveRoomResponse(String(vip), true, deps));
    await ok(await deleteRoomResponse(req({ confirm: `${P}gone` }, "DELETE"), String(gone), deps));
    await ok(await createRoleResponse(req({ label: "Regular", level: 37 }), deps));
    await ok(await patchRoleResponse(req({ label: "Regulars", colour: "#33AA55", hoist: false }, "PATCH"), "level37", deps));
    await ok(await patchRoleResponse(req({ label: "Moderator" }, "PATCH"), "mod", deps));

    // Refused saves leave nothing: a channel in the hidden supporters space, an encrypted public one.
    const count = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM site.community_rooms WHERE name LIKE '${P}%'`)).rows[0]!.n;
    const before = await count();
    assert.equal((await createRoomResponse(room(`${P}bad`, { spaceId: gate }), deps)).status, 400);
    assert.equal((await createRoomResponse(room(`${P}bad`, { encrypted: true }), deps)).status, 400);
    assert.equal((await deleteSpaceResponse(String(stream), deps)).status, 409, "a category holding a channel stays");
    assert.equal(await count(), before);
    assert.equal(asked, 12, "each of the 12 saves asked the host once; no refusal did");

    const view = (await (await communityViewResponse({ pool: deps.pool, retentionCapDays: () => 365, reconciler: false, canAsk: false, host: async () => null })).json()) as Record<string, unknown>;
    assert.ok(Array.isArray(view.rooms) && Array.isArray(view.spaces) && Array.isArray(view.roles), JSON.stringify(view).slice(0, 300));

    // A new reader (the reconciler's feed reads through readDesired) sees exactly what was saved.
    const d = await readDesired(db);
    const mine = d.rooms.filter((r) => r.name.startsWith(P));
    assert.deepEqual(mine.map((r) => [r.name, r.archived, r.encrypted, r.published, r.retentionDays]).sort(), [
      [`${P}lobby`, false, false, true, 30], [`${P}vip`, true, true, false, null],
    ]);
    const live = d.spaces.find((s) => s.name === `${P}Live`)!;
    assert.equal(live.kind, "category");
    assert.equal(live.topic, "On air");
    assert.equal(mine.find((r) => r.name === `${P}lobby`)!.spaceId, live.id, "moved to the other category");
    assert.deepEqual(d.spaces.filter((s) => s.kind === "category" && s.name.startsWith(P)).map((s) => s.name), [`${P}Talk`, `${P}Live`], "made in order, kept in order");
    const role = d.roles.find((r) => r.key === "level37")!;
    assert.deepEqual([role.label, role.level, role.colour, role.hoist, role.builtin], ["Regulars", 37, "#33aa55", false, false]);
    assert.equal(d.roles.find((r) => r.key === "mod")!.label, "Moderator");
    assert.deepEqual(d.roles.map((r) => r.level).slice(0, 5), [100, 75, 50, 50, 37]);
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
});

test("isolation: nothing the test above wrote is visible afterwards (the shared database keeps its seven roles)", async (t) => {
  if (skipUnlessDb(t)) return;
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  try {
    const roles = (await db.query<{ key: string }>(`SELECT key FROM site.community_roles WHERE key = 'level37' OR label = 'Moderator'`)).rows;
    assert.deepEqual(roles, []);
    const rows = (await db.query<{ n: number }>(`SELECT (SELECT count(*) FROM site.community_rooms WHERE name LIKE '${P}%')
      + (SELECT count(*) FROM site.community_spaces WHERE name LIKE '${P}%') AS n`)).rows[0]!;
    assert.equal(Number(rows.n), 0);
  } finally {
    await db.end();
  }
});
