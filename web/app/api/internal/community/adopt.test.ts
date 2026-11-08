// POST /api/internal/community/adopt: the reconciler's adopt mode imports a room or space no row
// knows, or moves a row to its upgraded room. The handler runs here over a fake db; the body is the
// reconciler core's own op (install/matrix/reconcile-core.mjs), so a change of shape on either side
// fails here. The same SQL against real tables: app/lib/community/adoptServer.db.test.ts; what the
// real reconciler posts on a real homeserver: app/lib/community/reconcile.hs.test.ts.
// Run: env -u DATABASE_URL node --test app/api/internal/community/adopt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
import { adoptPostResponse, parseAdopt } from "../../../lib/community/adoptServer.ts";

// The core lives outside web/: loaded at run time, because the site image is built (and type-checked)
// from web/ alone.
const CORE = new URL("../../../../../install/matrix/reconcile-core.mjs", import.meta.url).href;
const { planAll } = (await import(CORE)) as { planAll: (desired: unknown, actual: unknown, o: { mode: string }) => { ops: unknown[] } };

const SECRET = "test-internal-secret";
const S = "example.test";
const rid = (x: string) => `!${x}:${S}`;
const quiet = { error: () => {} };
const fixture = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../../../../../install/fixtures/community", f), "utf8"));

type Call = { sql: string; params?: unknown[] };
/** Answers by statement: `spaces` maps a room id to its space row id; `rooms` to a room row id;
 *  `siblings` are the order keys under the parent; `hub` whether a hub row exists. */
function fakeDb(o: { spaces?: Record<string, number>; rooms?: Record<string, number>; siblings?: string[]; unmade?: string[]; hub?: boolean;
  updated?: boolean; current?: string | null; fail?: number } = {}) {
  const calls: Call[] = [];
  let fail = o.fail ?? 0;
  let nextId = 40;
  const db = {
    calls,
    query: async <R extends object>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> => {
      calls.push({ sql, params });
      if (fail > 0) { fail--; throw new Error("connection terminated"); }
      const rows = (x: unknown[]) => ({ rows: x as R[] });
      const id = params?.[0] as string;
      if (/^\s*SELECT 1 FROM site\.community_rooms WHERE matrix_room_id/.test(sql)) return rows(o.rooms?.[id] ? [{}] : []);
      if (/^\s*SELECT 1 FROM site\.community_spaces WHERE matrix_room_id/.test(sql)) return rows(o.spaces?.[id] ? [{}] : []);
      if (/^\s*SELECT id FROM site\.community_spaces WHERE matrix_room_id/.test(sql)) return rows(o.spaces?.[id] ? [{ id: o.spaces[id] }] : []);
      if (/^\s*SELECT id FROM site\.community_rooms WHERE matrix_room_id/.test(sql)) return rows(o.rooms?.[id] ? [{ id: o.rooms[id] }] : []);
      if (/kind = 'hub'/.test(sql)) return rows(o.hub ? [{ id: 1 }] : []);
      if (/UNION ALL/.test(sql)) return rows([...(o.siblings ?? []).map((k) => ({ order_key: k, made: true })), ...(o.unmade ?? []).map((k) => ({ order_key: k, made: false }))]);
      // The hub's import with setup's channels: one statement inserts both.
      if (/^\s*WITH hub AS \(/.test(sql)) return rows([{ id: nextId++ }]);
      if (/^\s*INSERT INTO/.test(sql)) return rows([{ id: nextId++ }]);
      if (/^\s*UPDATE/.test(sql)) return rows(o.updated === false ? [] : [{ id: params?.[0] }]);
      if (/^\s*SELECT matrix_room_id FROM/.test(sql)) return rows([{ matrix_room_id: o.current ?? null }]);
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  return db;
}

const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  new Request("http://site.test/api/internal/community/adopt", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
  });
const inserts = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => /^\s*INSERT INTO/.test(c.sql));

/** What the core plans in adopt mode for the fixture community plus rooms made by hand. */
type Op = { [k: string]: unknown; row: Record<string, unknown>; roomId: string };
function coreAdoptOps(): Op[] {
  const desired = fixture("feed.json");
  const actual = fixture("actual.json");
  const room = (x: object) => ({ name: null, topic: null, avatar: null, joinRule: "invite", allow: [], history: "shared", retention: null,
    encrypted: false, published: false, powerLevels: { events_default: 0, users: {} }, members: {}, tombstone: null, creators: [`@streamer:${S}`], ...x });
  actual.hub.children.push({ roomId: rid("found"), via: [S] }, { roomId: rid("games"), order: "a5", via: [S] });
  actual.rooms[rid("hub")].children = actual.hub.children;
  actual.rooms[rid("found")] = room({ name: "found", topic: "made in Element", joinRule: "restricted",
    allow: [{ type: "m.room_membership", room_id: rid("hub") }], retention: 7 * 86_400_000, powerLevels: { events_default: 50, users: {} } });
  actual.rooms[rid("games")] = room({ type: "m.space", name: "Games", children: [{ roomId: rid("chess"), via: [S] }] });
  actual.rooms[rid("chess")] = room({ name: "chess", forum: true });
  actual.rooms[rid("general")].tombstone = { replacement_room: rid("general2") };
  actual.rooms[rid("general2")] = { ...actual.rooms[rid("general")], tombstone: null };
  // No hub row yet: the first adopt imports the hub itself (from matrix.rooms.hub).
  desired.spaces = desired.spaces.filter((s: { kind: string }) => s.kind !== "hub");
  // As the reconciler sends each op: through JSON.
  return JSON.parse(JSON.stringify(planAll(desired, actual, { mode: "adopt" }).ops));
}
/** The same ops by name: the hub, the room found in it, the category and its forum. */
function adoptOps() {
  const ops = coreAdoptOps();
  const of = (room: string) => ops.find((o) => o.op === "adoptRow" && o.matrixRoomId === rid(room))!;
  return { hubOp: of("hub"), foundOp: of("found"), gamesOp: of("games"), chessOp: of("chess") };
}

test("POST adopt without bearer → 401, nothing written", async () => {
  for (const auth of [null, "Bearer wrong"]) {
    const db = fakeDb();
    const res = await adoptPostResponse(post({ op: "adoptRow" }, auth), { db, secret: SECRET });
    assert.equal(res.status, 401);
    assert.equal(db.calls.length, 0);
  }
});

test("the core's adoptRow and followTombstone ops, exactly as the reconciler sends them, are accepted", () => {
  const ops = coreAdoptOps();
  // The hub's children in the core's fixed order: the ones with an `order` (games, a5) before the one
  // without (found), parents before their children.
  assert.deepEqual(ops.map((o) => [o.op, o.table, o.matrixRoomId ?? o.rowId]), [
    ["adoptRow", "spaces", rid("hub")],
    ["adoptRow", "spaces", rid("games")],
    ["adoptRow", "rooms", rid("chess")],
    ["adoptRow", "rooms", rid("found")],
    ["followTombstone", "rooms", 1],
  ], "vacuity: the core planned every kind of op this route takes");
  for (const op of ops) assert.ok(!("error" in parseAdopt(op)), `${JSON.stringify(op)} → ${JSON.stringify(parseAdopt(op))}`);
});

test("adopt: the hub first (no parent), then a room under it — inserted as they are, each given a place after its siblings", async () => {
  const { hubOp, foundOp } = adoptOps();
  const db = fakeDb();
  const res = await adoptPostResponse(post(hubOp), { db, secret: SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 40 });
  const [hubIns] = inserts(db);
  assert.match(hubIns!.sql, /INSERT INTO site\.community_spaces \(parent_id, kind, name, topic, avatar_mxc, order_key, matrix_room_id\)/);
  assert.deepEqual(hubIns!.params, [null, "hub", "Example Community", null, null, "a0", rid("hub")]);

  const db2 = fakeDb({ spaces: { [rid("hub")]: 1 }, siblings: ["a0", "a1", "Zz"] });
  const res2 = await adoptPostResponse(post(foundOp), { db: db2, secret: SECRET });
  assert.equal(res2.status, 200);
  const [roomIns] = inserts(db2);
  assert.match(roomIns!.sql, /INSERT INTO site\.community_rooms \(space_id, kind, name, topic, avatar_mxc, order_key, see_rule, post_rule,\s+retention_days, encrypted, published, archived, matrix_room_id\)/);
  // The link had no order (orderKey null): the next key after the last sibling, "a1".
  assert.deepEqual(roomIns!.params, [1, "text", "found", "made in Element", null, "a2", "everyone", "mods", 7, false, false, false, rid("found")]);
  // Spaces and rooms share one order under a parent.
  const sib = db2.calls.find((c) => /UNION ALL/.test(c.sql))!;
  assert.match(sib.sql, /SELECT order_key, matrix_room_id IS NOT NULL AS made FROM site\.community_spaces WHERE parent_id IS NOT DISTINCT FROM \$1\s+UNION ALL\s+SELECT order_key, matrix_room_id IS NOT NULL AS made FROM site\.community_rooms WHERE space_id = \$1/);
  assert.deepEqual(sib.params, [1]);
});

test("adopt: a link's own order is kept when it is one of the panel's keys; a foreign one is replaced", async () => {
  const { gamesOp } = adoptOps();
  const db = fakeDb({ spaces: { [rid("hub")]: 1 }, siblings: ["a0", "a1"] });
  assert.equal((await adoptPostResponse(post(gamesOp), { db, secret: SECRET })).status, 200);
  assert.equal(inserts(db)[0]!.params![5], "a5", "the category's order a5 kept");
  const db2 = fakeDb({ spaces: { [rid("hub")]: 1 }, siblings: ["a0", "a1"] });
  const foreign = { ...gamesOp!, row: { ...gamesOp!.row, orderKey: "zzz-not-ours" } };
  assert.equal((await adoptPostResponse(post(foreign), { db: db2, secret: SECRET })).status, 200);
  assert.equal(inserts(db2)[0]!.params![5], "a2");
});

test("adopt: a parent that is not a row yet → 409; a second hub → 409; a room already a space → 409; nothing inserted", async () => {
  const { hubOp, foundOp } = adoptOps();
  for (const [db, body] of [
    [fakeDb(), foundOp],
    [fakeDb({ hub: true }), hubOp],
    [fakeDb({ spaces: { [rid("found")]: 3, [rid("hub")]: 1 } }), foundOp],
  ] as const) {
    const res = await adoptPostResponse(post(body), { db, secret: SECRET });
    assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
    assert.equal(inserts(db).length, 0);
  }
});

test("retry: the same adoptRow sent again answers the row it made the first time, and inserts nothing", async () => {
  const { foundOp } = adoptOps();
  const db = fakeDb({ spaces: { [rid("hub")]: 1 }, rooms: { [rid("found")]: 12 } });
  // Already a room row (the first send was written, its answer lost): the same id back.
  const first = fakeDb({ spaces: { [rid("hub")]: 1 } });
  assert.equal((await adoptPostResponse(post(foundOp), { db: first, secret: SECRET })).status, 200);
  assert.equal(inserts(first).length, 1, "vacuity: a first send inserts");
  const res = await adoptPostResponse(post(foundOp), { db, secret: SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 12 });
  assert.equal(inserts(db).length, 0);
});

test("followTombstone: the row moves to the upgraded room only while it names the old one; a retry is fine", async () => {
  const follow = coreAdoptOps().find((o) => o.op === "followTombstone")!;
  const db = fakeDb();
  const res = await adoptPostResponse(post(follow), { db, secret: SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: 1 });
  assert.match(db.calls[0]!.sql, /^\s*UPDATE site\.community_rooms SET matrix_room_id = \$3, updated_at = now\(\)\s+WHERE id = \$1 AND matrix_room_id = \$2\s+RETURNING id\s*$/);
  assert.deepEqual(db.calls[0]!.params, [1, rid("general"), rid("general2")]);
  // Retry: the row already names the new room.
  assert.equal((await adoptPostResponse(post(follow), { db: fakeDb({ updated: false, current: rid("general2") }), secret: SECRET })).status, 200);
  // Changed meanwhile (another room) or gone: 409.
  for (const current of [rid("elsewhere"), null]) {
    assert.equal((await adoptPostResponse(post(follow), { db: fakeDb({ updated: false, current }), secret: SECRET })).status, 409);
  }
});

test("adopt: anything but the core's two ops, whole and well formed, is 400 and writes nothing", async () => {
  const { hubOp, foundOp, gamesOp } = adoptOps();
  const follow = coreAdoptOps().find((o) => o.op === "followTombstone")!;
  const bad = [
    "{not json", "[]", { op: "deleteRoom" },
    { ...foundOp, matrixRoomId: "#alias:example.test" }, { ...foundOp, row: { ...foundOp!.row, matrixRoomId: rid("other") } },
    { ...foundOp, parentRoomId: null }, { ...foundOp, row: { ...foundOp!.row, see: "friends" } },
    { ...foundOp, row: { ...foundOp!.row, post: undefined } }, { ...foundOp, row: { ...foundOp!.row, kind: "voice" } },
    { ...foundOp, row: { ...foundOp!.row, retentionDays: 0 } }, { ...foundOp, row: { ...foundOp!.row, retentionDays: 3651 } },
    { ...foundOp, row: { ...foundOp!.row, encrypted: "yes" } }, { ...foundOp, row: { ...foundOp!.row, discordChannelId: "1" } },
    { ...foundOp, row: { ...foundOp!.row, avatarMxc: "https://x/y.png" } }, { ...foundOp, row: { ...foundOp!.row, name: "x".repeat(256) } },
    { ...hubOp, parentRoomId: rid("talk") }, { ...gamesOp, parentRoomId: null }, { ...gamesOp, row: { ...gamesOp!.row, kind: "gate" } },
    { ...foundOp, table: "users" },
    { ...follow, rowId: 0 }, { ...follow, rowId: "1" }, { ...follow, to: follow.roomId }, { ...follow, table: "users" },
  ];
  for (const body of bad) {
    const db = fakeDb();
    const res = await adoptPostResponse(post(body), { db, secret: SECRET });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(db.calls.length, 0);
  }
});

// Setup's list (community.setupChannels): no channel row can exist before the home's row, so the
// hub's import writes them with it, in the same statement — a failure leaves neither.
const SETUP = { channels: [{ kind: "announcement" as const, name: "announcements" }, { kind: "text" as const, name: "off-topic" }], retentionCapDays: 365 };

test("the hub's import brings setup's channels with it, in one statement; none listed = the plain insert", async () => {
  const { hubOp } = adoptOps();
  const db = fakeDb();
  const res = await adoptPostResponse(post(hubOp), { db, secret: SECRET, setup: () => SETUP });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, id: 40 });
  const writes = db.calls.filter((c) => /^\s*(INSERT|WITH|UPDATE|DELETE)/.test(c.sql));
  assert.equal(writes.length, 1, "one statement");
  assert.match(writes[0]!.sql, /^\s*WITH hub AS \(\s*INSERT INTO site\.community_spaces \(parent_id, kind, name, topic, avatar_mxc, order_key, matrix_room_id\)/);
  assert.match(writes[0]!.sql, /INSERT INTO site\.community_rooms \(space_id, kind, name, order_key, see_rule, post_rule, retention_days, encrypted, published, archived\)\s+SELECT hub\.id,/);
  assert.match(writes[0]!.sql, /SELECT id FROM hub\s*$/);
  const [, , , , , , , channels] = writes[0]!.params as unknown[];
  assert.deepEqual(JSON.parse(channels as string), [
    { kind: "announcement", name: "announcements", orderKey: "a0", see: "everyone", post: "mods", retentionDays: null, published: true },
    { kind: "text", name: "off-topic", orderKey: "a1", see: "everyone", post: "everyone", retentionDays: 30, published: true },
  ]);
  // Nothing listed (an install set up before this, the owner's own site): the hub alone, as before.
  for (const setup of [undefined, () => ({ channels: [], retentionCapDays: 365 })]) {
    const plain = fakeDb();
    assert.equal((await adoptPostResponse(post(hubOp), { db: plain, secret: SECRET, setup })).status, 200);
    assert.equal(inserts(plain).length, 1);
    assert.ok(!plain.calls.some((c) => /community_rooms/.test(c.sql) && /INSERT/.test(c.sql)), "no channel row");
  }
  // Only the hub brings them: a category or a room never does.
  const { foundOp, gamesOp } = adoptOps();
  for (const op of [foundOp, gamesOp]) {
    const other = fakeDb({ spaces: { [rid("hub")]: 1 } });
    assert.equal((await adoptPostResponse(post(op), { db: other, secret: SECRET, setup: () => SETUP })).status, 200);
    assert.ok(!other.calls.some((c) => /^\s*WITH hub AS/.test(c.sql)));
  }
});

test("a room found in the community goes before the channels not made yet (setup's #general and #forum before the rest)", async () => {
  const { foundOp } = adoptOps();
  // Under the hub: setup's two channels (a0, a1) not made yet; nothing made.
  const db = fakeDb({ spaces: { [rid("hub")]: 1 }, unmade: ["a0", "a1"] });
  assert.equal((await adoptPostResponse(post(foundOp), { db, secret: SECRET })).status, 200);
  const first = inserts(db)[0]!.params![5] as string;
  assert.ok(first < "a0", `${first} is before the first channel not made yet`);
  // A second found room: after the first, still before them.
  const db2 = fakeDb({ spaces: { [rid("hub")]: 1 }, siblings: [first], unmade: ["a0", "a1"] });
  assert.equal((await adoptPostResponse(post({ ...foundOp!, matrixRoomId: rid("found2"), row: { ...foundOp!.row, matrixRoomId: rid("found2") } }), { db: db2, secret: SECRET })).status, 200);
  const second = inserts(db2)[0]!.params![5] as string;
  assert.ok(first < second && second < "a0", `${first} < ${second} < a0`);
  // With nothing waiting, the old rule: after the last sibling.
  const db3 = fakeDb({ spaces: { [rid("hub")]: 1 }, siblings: ["a0", "a1"] });
  assert.equal((await adoptPostResponse(post(foundOp), { db: db3, secret: SECRET })).status, 200);
  assert.equal(inserts(db3)[0]!.params![5], "a2");
});

test("retry: the hub's import sent again answers the hub row and writes no channel twice", async () => {
  const { hubOp } = adoptOps();
  const db = fakeDb({ spaces: { [rid("hub")]: 7 } });
  const res = await adoptPostResponse(post(hubOp), { db, secret: SECRET, setup: () => SETUP });
  assert.deepEqual(await res.json(), { ok: true, id: 7 });
  assert.ok(!db.calls.some((c) => /^\s*(INSERT|WITH)/.test(c.sql)), "nothing written");
  // A first send whose statement failed wrote nothing (one statement); the retry writes both.
  const flaky = fakeDb({ fail: 0 });
  const failing = { query: async () => { throw new Error("connection terminated"); } };
  assert.equal((await adoptPostResponse(post(hubOp), { db: failing, secret: SECRET, setup: () => SETUP, log: quiet })).status, 503);
  assert.equal((await adoptPostResponse(post(hubOp), { db: flaky, secret: SECRET, setup: () => SETUP })).status, 200);
  assert.equal(flaky.calls.filter((c) => /^\s*WITH hub AS/.test(c.sql)).length, 1);
});

test("retry: a write that failed answers 503 (the reconciler sends it again); a unique clash is 409", async () => {
  const { foundOp } = adoptOps();
  const db = fakeDb({ fail: 1, spaces: { [rid("hub")]: 1 } });
  assert.equal((await adoptPostResponse(post(foundOp), { db, secret: SECRET, log: quiet })).status, 503);
  assert.equal((await adoptPostResponse(post(foundOp), { db, secret: SECRET, log: quiet })).status, 200);
  const clash = { query: async () => { throw Object.assign(new Error("duplicate key value"), { code: "23505" }); } };
  assert.equal((await adoptPostResponse(post(foundOp), { db: clash, secret: SECRET, log: quiet })).status, 409);
});

const route = stripComments(readFileSync(join(import.meta.dirname, "adopt", "route.ts"), "utf8"));

test("route.ts is one call into the handler tested above, with the pool and the internal secret", () => {
  assert.match(route, /^import pool from "@\/lib\/db";$/m);
  assert.match(route, /export const dynamic = "force-dynamic";/);
  assert.equal(route.match(/export async function [A-Z]+\b/g)?.join(), "export async function POST", "one verb");
});

test("END anchor: route.ts was read to its last line — the pool, the internal secret and setup's list", () => {
  assert.match(route, /export async function POST\(req: Request\) \{\s*return adoptPostResponse\(req, \{ db: pool, secret: process\.env\.STREAM_API_SECRET, setup: setupChannelsNow \}\);\s*\}\s*$/);
});
