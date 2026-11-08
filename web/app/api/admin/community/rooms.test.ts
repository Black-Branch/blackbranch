// Admin Panel › Site › Community: the routes that write the community's desired state, then ask the
// host to make the server match. Mocked pool + a spy for the host request; the real-Postgres half
// (the transaction, a fresh connection reading what was saved) is rooms.db.test.ts.
// Run: env -u DATABASE_URL node --test app/api/admin/community/rooms.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../lib/sourceText.mjs";
import {
  createRoomResponse, patchRoomResponse, archiveRoomResponse, deleteRoomResponse,
  createSpaceResponse, deleteSpaceResponse, createRoleResponse, patchRoleResponse, reconcileResponse,
  type CommunityDeps,
} from "../../../lib/community/communityAdmin.ts";

const here = dirname(fileURLToPath(import.meta.url));

type Call = { sql: string; params: unknown[] };
type Answer = (sql: string, params: unknown[]) => object[] | undefined;

/** A pool whose one client logs every statement and answers from `answer`. */
function harness(answer: Answer = () => undefined, ask: CommunityDeps["ask"] = async () => ({ ok: true, requestedAt: "2026-10-23T12:00:00Z" })) {
  const calls: Call[] = [];
  const asked: number[] = [];
  let released = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return { rows: answer(sql, params) ?? [] };
  };
  const deps: CommunityDeps = {
    pool: { query: query as never, connect: async () => ({ query: query as never, release: () => { released++; } }) },
    ask: async () => { asked.push(calls.length); return ask(); },
    retentionCapDays: () => 365,
    log: { log: () => {}, error: () => {} },
  };
  return { deps, calls, asked, released: () => released };
}

const json = (body: unknown, method = "POST") => new Request("http://x/api/admin/community", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

/** The category a test room goes in, and its rooms' order keys. */
const spaceAnswer = (kind = "category", keys: string[] = []): Answer => (sql) => {
  if (/FROM site\.community_spaces WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ id: 3, kind }];
  if (/SELECT id, order_key FROM site\.community_rooms WHERE space_id/.test(sql)) return keys.map((k, i) => ({ id: i + 1, order_key: k }));
  if (/INSERT INTO site\.community_rooms/.test(sql)) return [{ id: 41 }];
  return undefined;
};

const NEW_ROOM = { spaceId: 3, kind: "text", name: "lobby", see: "everyone", post: "everyone", retentionDays: 30, encrypted: false };

test("POST rooms with see everyone and encrypted true → 400 with the exact message", async () => {
  const h = harness(spaceAnswer());
  const r = await read(await createRoomResponse(json({ ...NEW_ROOM, encrypted: true }), h.deps));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "A channel everyone can see cannot be encrypted.");
  assert.equal(h.calls.filter((c) => /INSERT/.test(c.sql)).length, 0, "nothing written");
  assert.equal(h.asked.length, 0, "the host is not asked");
});

test("POST rooms inserts and requests community-reconcile", async () => {
  const h = harness(spaceAnswer("category", ["a0", "a1"]));
  const r = await read(await createRoomResponse(json(NEW_ROOM), h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { ok: true, id: 41, requestedAt: "2026-10-23T12:00:00Z" });
  const sqls = h.calls.map((c) => c.sql);
  const ins = h.calls.find((c) => /INSERT INTO site\.community_rooms/.test(c.sql))!;
  assert.ok(ins, "the row is inserted");
  // space, kind, name, topic, icon, order (after the last), see, post, days, encrypted, published, archived
  assert.deepEqual(ins.params, [3, "text", "lobby", null, null, "a2", "everyone", "everyone", 30, false, true, false]);
  assert.ok(sqls.indexOf("BEGIN") < sqls.findIndex((s) => /INSERT/.test(s)) && sqls.findIndex((s) => /INSERT/.test(s)) < sqls.indexOf("COMMIT"),
    "inside one transaction");
  assert.deepEqual(h.asked, [h.calls.length], "the host is asked once, after the commit");
  assert.equal(h.released(), 1);
});

test("POST rooms: a channel only some can see is never published, and may be encrypted", async () => {
  const h = harness(spaceAnswer());
  const r = await read(await createRoomResponse(json({ ...NEW_ROOM, see: "supporters", encrypted: true }), h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ins = h.calls.find((c) => /INSERT INTO site\.community_rooms/.test(c.sql))!;
  assert.equal(ins.params[9], true, "encrypted");
  assert.equal(ins.params[10], false, "not published");
});

test("POST rooms: a gate space or a missing one is refused, and the transaction is rolled back", async () => {
  for (const kind of ["gate", null]) {
    const h = harness((sql) => (/FOR UPDATE/.test(sql) ? (kind ? [{ id: 3, kind }] : []) : undefined));
    const r = await read(await createRoomResponse(json(NEW_ROOM), h.deps));
    assert.equal(r.status, kind ? 400 : 404, `${kind}`);
    assert.ok(h.calls.some((c) => c.sql === "ROLLBACK"), `${kind}: rolled back`);
    assert.equal(h.asked.length, 0);
    assert.equal(h.released(), 1);
  }
});

test("POST rooms: retention past the install's cap is refused with the cap in the words", async () => {
  const h = harness(spaceAnswer());
  h.deps.retentionCapDays = () => 90;
  const r = await read(await createRoomResponse(json({ ...NEW_ROOM, retentionDays: 120 }), h.deps));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Messages are kept 1 to 90 days, or with no limit.");
  const ok = await read(await createRoomResponse(json({ ...NEW_ROOM, retentionDays: null }), h.deps));
  assert.equal(ok.status, 200, "forever (null) is always allowed");
});

const ROOM_ROW = {
  id: 41, spaceId: 3, kind: "text", name: "lobby", topic: null, avatarMxc: null, orderKey: "a2", see: "everyone", post: "everyone",
  retentionDays: 30, encrypted: false, published: true, archived: false, matrixRoomId: null, discordChannelId: null,
};
const roomAnswer = (row: object | null = ROOM_ROW): Answer => (sql) => {
  if (/FROM site\.community_rooms WHERE id = \$1 FOR UPDATE/.test(sql)) return row ? [row] : [];
  if (/FROM site\.community_spaces WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ id: 3, kind: "category" }];
  if (/^\s*UPDATE site\.community_rooms/.test(sql)) return [{ id: 41 }];
  if (/^\s*DELETE FROM site\.community_rooms/.test(sql)) return [{ id: 41 }];
  return undefined;
};

test("PATCH rooms encrypted → 409", async () => {
  for (const encrypted of [true, false]) {
    const h = harness(roomAnswer());
    const r = await read(await patchRoomResponse(json({ encrypted }, "PATCH"), "41", h.deps));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "Encryption is set when a channel is made and cannot be changed.");
    assert.equal(h.calls.length, 0, "nothing read or written");
    assert.equal(h.asked.length, 0);
  }
});

test("PATCH rooms: a rename writes the merged row and asks the host; published follows who can see", async () => {
  const h = harness(roomAnswer());
  const r = await read(await patchRoomResponse(json({ name: "general-chat", see: "supporters" }, "PATCH"), "41", h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const up = h.calls.find((c) => /^UPDATE site\.community_rooms/.test(c.sql))!;
  assert.ok(up, "updated");
  assert.equal(up.params[0], 41);
  assert.ok(up.params.includes("general-chat") && up.params.includes("supporters"));
  assert.match(up.sql, /published = \$\d+/);
  const pub = up.params[Number(/published = \$(\d+)/.exec(up.sql)![1]) - 1];
  assert.equal(pub, false, "a channel only supporters see is not published");
  assert.equal(h.asked.length, 1);
});

test("PATCH rooms: an encrypted channel cannot be opened to everyone", async () => {
  const h = harness(roomAnswer({ ...ROOM_ROW, see: "mods", encrypted: true, published: false }));
  const r = await read(await patchRoomResponse(json({ see: "everyone" }, "PATCH"), "41", h.deps));
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "A channel everyone can see cannot be encrypted.");
  assert.ok(h.calls.some((c) => c.sql === "ROLLBACK"));
});

test("PATCH rooms: a channel linked to Discord stays open to everyone (the bridge keeps it so)", async () => {
  const h = harness(roomAnswer({ ...ROOM_ROW, discordChannelId: "100000000000000201" }));
  const r = await read(await patchRoomResponse(json({ see: "mods" }, "PATCH"), "41", h.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /linked to Discord.*Unlink it on the Discord page first/);
  assert.ok(!h.calls.some((c) => /^UPDATE site\.community_rooms/.test(c.sql)));
  // …nor narrowed for posting: that follows the Discord channel.
  const hp = harness(roomAnswer({ ...ROOM_ROW, discordChannelId: "100000000000000201" }));
  const rp = await read(await patchRoomResponse(json({ post: "supporters" }, "PATCH"), "41", hp.deps));
  assert.equal(rp.status, 409);
  assert.match(String(rp.body.error), /who may post follows the Discord channel/);
  // A rename of the same linked channel still goes through.
  const h2 = harness(roomAnswer({ ...ROOM_ROW, discordChannelId: "100000000000000201" }));
  assert.equal((await patchRoomResponse(json({ name: "lobby" }, "PATCH"), "41", h2.deps)).status, 200);
});

test("PATCH rooms: an unknown channel is 404; a bad id is 400", async () => {
  const h = harness(roomAnswer(null));
  assert.equal((await patchRoomResponse(json({ name: "x" }, "PATCH"), "41", h.deps)).status, 404);
  assert.equal((await patchRoomResponse(json({ name: "x" }, "PATCH"), "4x", h.deps)).status, 400);
});

test("retry: the same PATCH sent twice leaves the same row and asks the host each time", async () => {
  const h = harness(roomAnswer());
  for (let i = 0; i < 2; i++) {
    const r = await read(await patchRoomResponse(json({ topic: "say hi" }, "PATCH"), "41", h.deps));
    assert.equal(r.status, 200);
  }
  const ups = h.calls.filter((c) => /^UPDATE site\.community_rooms/.test(c.sql));
  assert.equal(ups.length, 2);
  assert.deepEqual(ups[0]!.params, ups[1]!.params, "the second send writes exactly what the first did");
  assert.equal(h.asked.length, 2);
});

test("retry: a host that cannot be asked still saves; the answer says nothing was requested", async () => {
  const h = harness(spaceAnswer(), async () => ({ ok: false, error: "this install has no host request folder" }));
  const r = await read(await createRoomResponse(json(NEW_ROOM), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: 41, requestedAt: null });
  assert.ok(h.calls.some((c) => c.sql === "COMMIT"));
});

test("archive and unarchive flip the one flag and ask the host", async () => {
  for (const archived of [true, false]) {
    const h = harness(roomAnswer());
    const r = await read(await archiveRoomResponse("41", archived, h.deps));
    assert.equal(r.status, 200);
    const up = h.calls.find((c) => /^UPDATE site\.community_rooms SET archived/.test(c.sql))!;
    assert.deepEqual(up.params, [41, archived]);
    assert.equal(h.asked.length, 1);
  }
});

test("DELETE rooms without the typed name → 400", async () => {
  for (const body of [{}, { confirm: "" }, { confirm: "Lobby" }, { confirm: "#lobby" }]) {
    const h = harness(roomAnswer());
    const r = await read(await deleteRoomResponse(json(body, "DELETE"), "41", h.deps));
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error, "Type the channel name to confirm.");
    assert.equal(h.calls.filter((c) => /^DELETE/.test(c.sql)).length, 0);
  }
});

test("DELETE rooms with the typed name removes a channel the server never made", async () => {
  const h = harness(roomAnswer());
  const r = await read(await deleteRoomResponse(json({ confirm: "lobby" }, "DELETE"), "41", h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(h.calls.some((c) => /^DELETE FROM site\.community_rooms WHERE id = \$1/.test(c.sql)));
});

test("DELETE rooms waits while a run is in progress (it may be making that very room)", async () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  const runs = (rows: object[]): Answer => (sql, p) => (/FROM site\.community_runs/.test(sql) ? rows : roomAnswer()(sql, p));
  const cases: { what: string; rows: object[]; host: { ok: boolean; at: string; message: string } | null; refused: boolean }[] = [
    { what: "the last run has not finished", rows: [{ finished_at: null, started_at: "2026-10-23T11:59:00Z" }], host: null, refused: true },
    // A run posts its row when it starts (two-phase); one unfinished for longer than the unit may run
    // (TimeoutStartSec, 20 min) crashed, and must not block deletes for ever.
    { what: "an unfinished run 19 minutes old is still going", rows: [{ finished_at: null, started_at: "2026-10-23T11:41:00Z" }], host: null, refused: true },
    { what: "an unfinished run 30 minutes old is stale (it crashed)", rows: [{ finished_at: null, started_at: "2026-10-23T11:30:00Z" }], host: null, refused: false },
    { what: "the host started one a minute ago and no run has logged since", rows: [{ finished_at: "2026-10-23T11:00:05Z", started_at: "2026-10-23T11:00:00Z" }],
      host: { ok: true, at: "2026-10-23T11:59:00Z", message: "started" }, refused: true },
    { what: "the run the host started has logged", rows: [{ finished_at: "2026-10-23T11:59:30Z", started_at: "2026-10-23T11:59:01Z" }],
      host: { ok: true, at: "2026-10-23T11:59:00Z", message: "started" }, refused: false },
    { what: "the host started one 30 minutes ago", rows: [], host: { ok: true, at: "2026-10-23T11:30:00Z", message: "started" }, refused: false },
    { what: "the host refused to start one", rows: [], host: { ok: false, at: "2026-10-23T11:59:00Z", message: "off" }, refused: false },
  ];
  for (const c of cases) {
    const h = harness(runs(c.rows));
    h.deps.hostAnswer = async () => c.host;
    h.deps.now = () => now;
    const r = await read(await deleteRoomResponse(json({ confirm: "lobby" }, "DELETE"), "41", h.deps));
    if (c.refused) {
      assert.equal(r.status, 409, c.what);
      assert.equal(r.body.error, "Wait for the current run to finish, then try again.", c.what);
      assert.equal(h.calls.filter((x) => /^DELETE/.test(x.sql)).length, 0, c.what);
    } else assert.equal(r.status, 200, `${c.what}: ${JSON.stringify(r.body)}`);
  }
});

test("POST rooms with the install's cap off (0): any days up to the ten-year ceiling, or no limit", async () => {
  const h = harness(spaceAnswer());
  h.deps.retentionCapDays = () => 0;
  assert.equal((await createRoomResponse(json({ ...NEW_ROOM, retentionDays: 1000 }), h.deps)).status, 200);
  assert.equal((await createRoomResponse(json({ ...NEW_ROOM, retentionDays: null }), h.deps)).status, 200);
  const over = await read(await createRoomResponse(json({ ...NEW_ROOM, retentionDays: 3651 }), h.deps));
  assert.equal(over.status, 400);
  assert.equal(over.body.error, "Messages are kept 1 to 3650 days, or with no limit.");
  const p = harness(roomAnswer());
  p.deps.retentionCapDays = () => 0;
  assert.equal((await patchRoomResponse(json({ retentionDays: 2000 }, "PATCH"), "41", p.deps)).status, 200);
});

test("DELETE rooms: a channel already on the server is archived instead, never left to come back", async () => {
  // A deleted row whose room is still in the community would be imported again by the next adopt
  // (the reconciler never touches a room no row knows), so it is refused with the way that works.
  const h = harness(roomAnswer({ ...ROOM_ROW, matrixRoomId: "!abc:example.test" }));
  const r = await read(await deleteRoomResponse(json({ confirm: "lobby" }, "DELETE"), "41", h.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /Archive it instead/);
  assert.equal(h.calls.filter((c) => /^DELETE/.test(c.sql)).length, 0);
});

test("POST spaces makes a category after the last one; a gate or a channel's space is no parent", async () => {
  const h = harness((sql, params) => {
    if (/FROM site\.community_spaces WHERE id = \$1 FOR UPDATE/.test(sql)) return params[0] === 1 ? [{ id: 1, kind: "hub" }] : [{ id: 9, kind: "gate" }];
    if (/SELECT id, order_key FROM site\.community_spaces/.test(sql)) return [{ id: 2, order_key: "a0" }];
    if (/INSERT INTO site\.community_spaces/.test(sql)) return [{ id: 5 }];
    return undefined;
  });
  const r = await read(await createSpaceResponse(json({ name: "Stream", parentId: 1 }), h.deps));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ins = h.calls.find((c) => /INSERT INTO site\.community_spaces/.test(c.sql))!;
  assert.deepEqual(ins.params, [1, "Stream", "a1"]);
  assert.match(ins.sql, /'category'/);
  assert.equal(h.asked.length, 1);
  assert.equal((await createSpaceResponse(json({ name: "Stream", parentId: 9 }), h.deps)).status, 400);
  assert.equal((await createSpaceResponse(json({ name: "", parentId: null }), h.deps)).status, 400);
});

test("DELETE spaces only when empty", async () => {
  const h = harness((sql) => {
    if (/FROM site\.community_spaces WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ id: 5, kind: "category", name: "Stream", matrix_room_id: null }];
    if (/SELECT 1 FROM site\.community_rooms WHERE space_id/.test(sql)) return [{ "?column?": 1 }];
    return undefined;
  });
  const r = await read(await deleteSpaceResponse("5", h.deps));
  assert.equal(r.status, 409);
  assert.match(String(r.body.error), /Move or delete its channels first/);
  assert.equal(h.calls.filter((c) => /^DELETE/.test(c.sql)).length, 0);
});

test("roles: a built-in role's level is fixed; a new role's level is between Member and Admin and not a built-in's", async () => {
  const h = harness((sql) => {
    if (/FROM site\.community_roles WHERE key = \$1 FOR UPDATE/.test(sql)) return [{ key: "mod", level: 50, builtin: true }];
    if (/SELECT key, level, builtin FROM site\.community_roles$/.test(sql.trim())) return [{ key: "admin", level: 100, builtin: true }, { key: "mod", level: 50, builtin: true }, { key: "member", level: 0, builtin: true }];
    if (/SELECT key AS id, order_key FROM site\.community_roles/.test(sql)) return [{ id: "timeout", order_key: "a6" }];
    if (/INSERT INTO site\.community_roles/.test(sql)) return [{ key: "level25" }];
    return undefined;
  });
  assert.equal((await patchRoleResponse(json({ level: 60 }, "PATCH"), "mod", h.deps)).status, 409);
  const ok = await read(await patchRoleResponse(json({ label: "Moderator", colour: "#33aa55", hoist: true }, "PATCH"), "mod", h.deps));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  for (const level of [0, 100, 50, 7.5, -3]) {
    assert.equal((await createRoleResponse(json({ label: "Regular", level }), h.deps)).status, 400, `level ${level}`);
  }
  const made = await read(await createRoleResponse(json({ label: "Regular", level: 25 }), h.deps));
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.key, "level25");
});

test("POST reconcile asks for the run the mode names; anything else is refused", async () => {
  const modes: string[] = [];
  const h = harness();
  const deps = { ...h.deps, askMode: async (m: "report" | "apply") => { modes.push(m); return { ok: true as const, requestedAt: "2026-10-23T12:00:00Z" }; } };
  assert.equal((await reconcileResponse(json({ mode: "report" }), deps)).status, 200);
  assert.equal((await reconcileResponse(json({ mode: "apply" }), deps)).status, 200);
  assert.equal((await reconcileResponse(json({ mode: "adopt" }), deps)).status, 400);
  assert.deepEqual(modes, ["report", "apply"]);
  const refused = await read(await reconcileResponse(json({ mode: "apply" }), { ...deps, askMode: async () => ({ ok: false, error: "no folder" }) }));
  assert.equal(refused.status, 409);
});

test("every /api/admin/community handler checks admin first; each mutation checks same-origin too", () => {
  const dir = here;
  const routes = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith("route.ts"))
    .map((p) => ({ path: p, src: stripComments(readFileSync(join(dir, p), "utf8")) }));
  assert.ok(routes.length >= 8, `vacuity: found ${routes.length} community routes`);
  let handlers = 0;
  for (const { path, src } of routes) {
    for (const m of src.matchAll(/export async function (GET|PUT|PATCH|DELETE|POST)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)) {
      handlers++;
      const [, method, body] = m;
      const firstLine = body!.trim().split("\n")[0]!;
      if (method === "GET") assert.match(firstLine, /await requireAdminResponse\(\)/, `${path} GET does not start with the admin check`);
      else assert.match(firstLine, /await requireAdminMutation\(req\)/, `${path} ${method} does not start with the admin + same-origin check`);
      assert.match(body!, /if \(admin instanceof Response\) return admin;/, `${path} ${method} ignores the refusal`);
    }
  }
  assert.ok(handlers >= 11, `vacuity: ${handlers} handlers`);
});
