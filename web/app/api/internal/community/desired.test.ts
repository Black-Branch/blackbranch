// The reconciler's internal routes (the feed, the run log, the rooms it made). The handlers run here
// for real over a fake db (the route files import the pool through the @/lib/db alias, which
// node --test cannot resolve, so each route.ts is held by a source scan to one call into the handler
// it tests).
// Run: env -u DATABASE_URL node --test app/api/internal/community/desired.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "../../../lib/testSource.ts";
import { desiredFeedResponse, madePostResponse, runPostResponse, type DesiredFeed, type FeedEnv } from "../../../lib/community/desiredServer.ts";
import { internalBearerOk } from "../../../lib/internalSecret.ts";
import { SITE_BAN_REASON } from "../../../lib/siteBanReason.ts";

const SECRET = "test-internal-secret";
const ENV: FeedEnv = {
  serverName: "example.test", serviceUserId: "@blackbranch:example.test", readerUserId: null, hubRoomId: "!hub:example.test",
  streamerId: null, botIds: [], sources: ["stripe"], putBack: true, retentionCapDays: 365, bridgeAccounts: [],
};

/** A db that answers every read with no rows (roles with one, so the ladder is not filled) and
 *  records every statement; `fail` makes the next N queries throw. */
function fakeDb() {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const db = {
    calls,
    fail: 0,
    nextId: 7,
    /** Whether an UPDATE finds its row (no rows otherwise); conflict: the next UPDATE breaks the unique room id. */
    updated: true,
    conflict: false,
    query: async <R extends object>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> => {
      calls.push({ sql, params });
      if (db.fail > 0) { db.fail--; throw new Error("connection terminated"); }
      if (/FROM site\.community_roles/.test(sql)) return { rows: [{ key: "member", label: "Member", level: 0, colour: null, hoist: false, orderKey: "a5", builtin: true }] as unknown as R[] };
      if (/INSERT INTO site\.community_runs/.test(sql)) return { rows: [{ id: db.nextId++ }] as unknown as R[] };
      if (/^\s*UPDATE site\.community_runs/.test(sql)) return { rows: (db.updated ? [{ id: params?.[0] }] : []) as unknown as R[] };
      if (/^\s*UPDATE site\.community_(rooms|spaces)/.test(sql)) {
        if (db.conflict) { db.conflict = false; throw Object.assign(new Error("duplicate key value"), { code: "23505" }); }
        return { rows: (db.updated ? [{ id: params?.[0] }] : []) as unknown as R[] };
      }
      return { rows: [] };
    },
  };
  return db;
}

const get = (auth?: string) => new Request("http://site.test/api/internal/community/desired", { headers: auth ? { authorization: auth } : {} });
const post = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  new Request("http://site.test/api/internal/community/runs", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
  });
const quiet = { error: () => {} };

test("GET without bearer → 401", async () => {
  for (const auth of [undefined, "Bearer wrong", `Basic ${SECRET}`, SECRET, "Bearer "]) {
    const db = fakeDb();
    const res = await desiredFeedResponse(get(auth), { db, secret: SECRET, env: () => ENV });
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(await res.json(), { error: "unauthorized" }, "the body says nothing about why");
    assert.equal(db.calls.length, 0, "nothing is read before the secret is checked");
  }
});

test("GET with no secret configured → 401 for everyone, the secret's own value included", async () => {
  for (const secret of [undefined, ""]) {
    const res = await desiredFeedResponse(get("Bearer "), { db: fakeDb(), secret, env: () => ENV });
    assert.equal(res.status, 401);
  }
  assert.equal(internalBearerOk(`Bearer ${SECRET}`, ""), false);
});

test("with bearer → 200 and a DesiredFeed", async () => {
  const res = await desiredFeedResponse(get(`Bearer ${SECRET}`), { db: fakeDb(), secret: SECRET, env: () => ENV });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const feed = (await res.json()) as DesiredFeed;
  assert.deepEqual(feed, {
    serverName: "example.test", hubRoomId: "!hub:example.test", serviceUserId: "@blackbranch:example.test",
    hiddenUserIds: ["@blackbranch:example.test"],
    spaces: [], rooms: [], roles: [{ key: "member", label: "Member", level: 0, colour: null, hoist: false, orderKey: "a5", builtin: true }],
    people: [], supporters: [], banned: [], timedOut: [], putBack: true, retentionCapDays: 365,
    siteBanReason: SITE_BAN_REASON, bridgeBots: [], bridgeUserPatterns: [], discordBot: null, discordSpaceLinked: false,
  });
});

test("the route reads the Discord bridge's accounts from the host's results folder; a removed file means none again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-results-"));
  const was = process.env.BB_RESULTS_DIR;
  process.env.BB_RESULTS_DIR = dir;
  try {
    writeFileSync(join(dir, "discord-bridge.json"), JSON.stringify({ v: 1, bot: "@_ooye_bot:example.test", userPatterns: ["@_ooye_.*:example\\.test"] }));
    const on = (await (await desiredFeedResponse(get(`Bearer ${SECRET}`), { db: fakeDb(), secret: SECRET, env: () => ENV })).json()) as DesiredFeed;
    assert.deepEqual(on.bridgeBots, ["@_ooye_bot:example.test"]);
    assert.deepEqual(on.bridgeUserPatterns, ["@_ooye_.*:example\\.test"]);
    assert.deepEqual([on.discordBot, on.discordSpaceLinked], ["@_ooye_bot:example.test", false]);
    // What the bridge has linked, read into results/ by the host: the hub linked to a Discord server.
    writeFileSync(join(dir, "discord-bridge-links.json"), JSON.stringify({ v: 1, guilds: [{ guildId: "100000000000000101", autocreate: 0, spaceId: "!hub:example.test", privacyLevel: 1 }], links: [] }));
    const linked = (await (await desiredFeedResponse(get(`Bearer ${SECRET}`), { db: fakeDb(), secret: SECRET, env: () => ENV })).json()) as DesiredFeed;
    assert.equal(linked.discordSpaceLinked, true);
    // A big server's record (2000 channels, far past the 64 KB other host files are held to) still reads.
    const many = Array.from({ length: 2000 }, (_, i) => ({ channelId: String(100000000000000000 + i), roomId: `!room${i}:example.test`, guildId: "100000000000000101", name: `channel-${i}-with-a-long-name` }));
    const big = JSON.stringify({ v: 1, guilds: [{ guildId: "100000000000000101", autocreate: 0, spaceId: "!hub:example.test", privacyLevel: 1 }], links: many });
    assert.ok(big.length > 65_536, "vacuity: over the general cap");
    writeFileSync(join(dir, "discord-bridge-links.json"), big);
    assert.equal(((await (await desiredFeedResponse(get(`Bearer ${SECRET}`), { db: fakeDb(), secret: SECRET, env: () => ENV })).json()) as DesiredFeed).discordSpaceLinked, true);
    rmSync(join(dir, "discord-bridge.json"));
    const off = (await (await desiredFeedResponse(get(`Bearer ${SECRET}`), { db: fakeDb(), secret: SECRET, env: () => ENV })).json()) as DesiredFeed;
    assert.deepEqual([off.bridgeBots, off.bridgeUserPatterns], [[], []]);
  } finally {
    if (was === undefined) delete process.env.BB_RESULTS_DIR; else process.env.BB_RESULTS_DIR = was;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry: a failed database read answers 503 with no detail, and the next request succeeds", async () => {
  const db = fakeDb();
  db.fail = 1;
  const res = await desiredFeedResponse(get(`Bearer ${SECRET}`), { db, secret: SECRET, env: () => ENV, log: quiet });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  const again = await desiredFeedResponse(get(`Bearer ${SECRET}`), { db, secret: SECRET, env: () => ENV, log: quiet });
  assert.equal(again.status, 200);
});

const RUN = { mode: "apply", startedAt: "2026-10-23T12:00:00Z", finishedAt: "2026-10-23T12:00:04Z", ok: true, drift: [{ room: "general", topic: "reset" }], applied: [], error: null };

test("POST runs without bearer → 401, nothing written", async () => {
  const db = fakeDb();
  const res = await runPostResponse(post(RUN, null), { db, secret: SECRET });
  assert.equal(res.status, 401);
  assert.equal(db.calls.length, 0);
});

test("POST runs: a valid run → { id }, inserted with the jsonb lists as JSON and the last 50 kept", async () => {
  const db = fakeDb();
  const res = await runPostResponse(post(RUN), { db, secret: SECRET });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 7 });
  assert.equal(db.calls.length, 1, "one statement: insert and trim together");
  const { sql, params } = db.calls[0]!;
  assert.match(sql, /INSERT INTO site\.community_runs \(mode, started_at, finished_at, ok, drift, applied, error\)/);
  assert.match(sql, /DELETE FROM site\.community_runs\s+WHERE id NOT IN \(SELECT id FROM site\.community_runs ORDER BY id DESC LIMIT 49\)/);
  assert.deepEqual(params, ["apply", "2026-10-23T12:00:00.000Z", "2026-10-23T12:00:04.000Z", true, JSON.stringify(RUN.drift), "[]", null]);
});

test("POST runs: mode must be report, adopt or apply; bad JSON and a bad body are 400 and write nothing", async () => {
  for (const body of [{ ...RUN, mode: "destroy" }, { ...RUN, mode: undefined }, { ...RUN, startedAt: "soon" }, "{not json", "[]"]) {
    const db = fakeDb();
    const res = await runPostResponse(post(body), { db, secret: SECRET });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(db.calls.length, 0);
  }
});

test("POST runs: a body over the limit is 413", async () => {
  const res = await runPostResponse(post({ ...RUN, drift: "x".repeat(1_000_001) }), { db: fakeDb(), secret: SECRET });
  assert.equal(res.status, 413);
});

test("retry: a run whose write failed answers 503, and the reconciler's retry records it once", async () => {
  const db = fakeDb();
  db.fail = 1;
  assert.equal((await runPostResponse(post(RUN), { db, secret: SECRET, log: quiet })).status, 503);
  const again = await runPostResponse(post(RUN), { db, secret: SECRET, log: quiet });
  assert.equal(again.status, 200);
  assert.equal(db.calls.filter((c) => /INSERT/.test(c.sql)).length, 2, "the failed attempt and the retry");
  assert.equal(db.nextId, 8, "only the retry wrote a row");
});

// ── Two phases: a row when the run starts (so a run in progress is visible), finished by its id ────
test("POST runs, two phases: the start inserts an unfinished row → { id }; the finish updates THAT row", async () => {
  const db = fakeDb();
  const start = await runPostResponse(post({ mode: "apply", startedAt: "2026-10-23T12:00:00Z" }), { db, secret: SECRET });
  assert.equal(start.status, 200);
  assert.deepEqual(await start.json(), { id: 7 });
  assert.deepEqual(db.calls[0]!.params, ["apply", "2026-10-23T12:00:00.000Z", null, null, null, null, null], "unfinished: no end, no verdict yet");

  const fin = { id: 7, finishedAt: "2026-10-23T12:00:09Z", ok: true, drift: [], applied: [{ op: "rename" }], error: null };
  const done = await runPostResponse(post(fin), { db, secret: SECRET });
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { id: 7 });
  assert.equal(db.calls.length, 2, "one statement each");
  const { sql, params } = db.calls[1]!;
  assert.match(sql, /^\s*UPDATE site\.community_runs SET finished_at = \$2, ok = \$3, drift = \$4::jsonb, applied = \$5::jsonb, error = \$6\s+WHERE id = \$1 AND finished_at IS NULL\s+RETURNING id\s*$/);
  assert.deepEqual(params, [7, "2026-10-23T12:00:09.000Z", true, "[]", JSON.stringify(fin.applied), null]);
  assert.ok(!db.calls.some((c) => /DELETE/.test(c.sql) && c !== db.calls[0]), "the finish prunes nothing (the start's insert keeps the last 50)");
});

test("POST runs finish: a row already finished or gone → 409 (the reconciler then writes a one-shot row); a bad finish is 400", async () => {
  const db = fakeDb();
  db.updated = false;
  const r = await runPostResponse(post({ id: 7, finishedAt: "2026-10-23T12:00:09Z", ok: true, drift: [], applied: [], error: null }), { db, secret: SECRET });
  assert.equal(r.status, 409);
  for (const body of [
    { id: 0, finishedAt: "2026-10-23T12:00:09Z", ok: true }, { id: "7", finishedAt: "2026-10-23T12:00:09Z", ok: true },
    { id: 7, finishedAt: null, ok: true }, { id: 7, finishedAt: "soon", ok: true }, { id: 7, finishedAt: "2026-10-23T12:00:09Z", ok: "yes" },
    { id: 7, finishedAt: "2026-10-23T12:00:09Z", ok: true, error: 5 },
  ]) {
    const d = fakeDb();
    assert.equal((await runPostResponse(post(body), { db: d, secret: SECRET })).status, 400, JSON.stringify(body));
    assert.equal(d.calls.length, 0);
  }
});

test("POST runs without an id is the one-shot row it always was (an older reconciler, or a start that failed)", async () => {
  const db = fakeDb();
  const r = await runPostResponse(post(RUN), { db, secret: SECRET });
  assert.deepEqual(await r.json(), { id: 7 });
  assert.match(db.calls[0]!.sql, /INSERT INTO site\.community_runs/);
  assert.equal(db.calls[0]!.params![2], "2026-10-23T12:00:04.000Z", "finished in the same row");
});

// ── POST made: the id of a room the reconciler made, on its row ──────────────────────────────────
const MADE = { table: "rooms", id: 7, matrixRoomId: "!made1:example.test", replaces: null };
const postMade = (body: unknown, auth: string | null = `Bearer ${SECRET}`) =>
  new Request("http://site.test/api/internal/community/made", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
  });

test("POST made without bearer → 401, nothing written", async () => {
  for (const auth of [null, "Bearer wrong"]) {
    const db = fakeDb();
    const res = await madePostResponse(postMade(MADE, auth), { db, secret: SECRET });
    assert.equal(res.status, 401);
    assert.equal(db.calls.length, 0);
  }
});

test("POST made: the room's id goes on its row, only while the row still names the room it replaces", async () => {
  for (const [table, replaces] of [["rooms", null], ["spaces", "!gone:example.test"]] as const) {
    const db = fakeDb();
    const res = await madePostResponse(postMade({ ...MADE, table, replaces }), { db, secret: SECRET });
    assert.equal(res.status, 200, table);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(db.calls.length, 1);
    const { sql, params } = db.calls[0]!;
    assert.match(sql, new RegExp(`^\\s*UPDATE site\\.community_${table} SET matrix_room_id = \\$2, updated_at = now\\(\\)\\s+WHERE id = \\$1 AND matrix_room_id IS NOT DISTINCT FROM \\$3\\s+RETURNING id\\s*$`));
    assert.deepEqual(params, [7, "!made1:example.test", replaces]);
  }
});

test("POST made: a row that is gone or names another room now → 409; a room id another row has → 409", async () => {
  const db = fakeDb();
  db.updated = false;
  const res = await madePostResponse(postMade(MADE), { db, secret: SECRET });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /changed|gone/);
  const dup = fakeDb();
  dup.conflict = true;
  const res2 = await madePostResponse(postMade(MADE), { db: dup, secret: SECRET, log: quiet });
  assert.equal(res2.status, 409);
});

test("POST made: only a rooms or spaces row, a whole id and Matrix room ids; anything else is 400 and writes nothing", async () => {
  for (const body of [
    { ...MADE, table: "users" }, { ...MADE, table: undefined }, { ...MADE, id: 0 }, { ...MADE, id: 1.5 }, { ...MADE, id: "7" },
    { ...MADE, matrixRoomId: "#alias:example.test" }, { ...MADE, matrixRoomId: "" }, { ...MADE, matrixRoomId: "!a b:x" },
    { ...MADE, replaces: "general" }, "{not json", "[]",
  ]) {
    const db = fakeDb();
    const res = await madePostResponse(postMade(body), { db, secret: SECRET });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(db.calls.length, 0);
  }
});

test("retry: a made room whose write failed answers 503, and the reconciler's retry records it", async () => {
  const db = fakeDb();
  db.fail = 1;
  assert.equal((await madePostResponse(postMade(MADE), { db, secret: SECRET, log: quiet })).status, 503);
  const again = await madePostResponse(postMade(MADE), { db, secret: SECRET, log: quiet });
  assert.equal(again.status, 200);
  assert.equal(db.calls.length, 2, "the failed attempt and the retry");
});

const desiredRoute = stripComments(readFileSync(join(import.meta.dirname, "desired", "route.ts"), "utf8"));
const runsRoute = stripComments(readFileSync(join(import.meta.dirname, "runs", "route.ts"), "utf8"));
const madeRoute = stripComments(readFileSync(join(import.meta.dirname, "made", "route.ts"), "utf8"));

test("each route.ts is one call into the handler tested above, with the pool and the internal secret", () => {
  assert.match(desiredRoute, /export async function GET\(req: Request\) \{\s*return desiredFeedResponse\(req, \{ db: pool, secret: process\.env\.STREAM_API_SECRET, env: feedEnv \}\);\s*\}\s*$/);
  assert.match(runsRoute, /export async function POST\(req: Request\) \{\s*return runPostResponse\(req, \{ db: pool, secret: process\.env\.STREAM_API_SECRET \}\);\s*\}\s*$/);
  assert.match(madeRoute, /export async function POST\(req: Request\) \{\s*return madePostResponse\(req, \{ db: pool, secret: process\.env\.STREAM_API_SECRET \}\);\s*\}\s*$/);
  for (const src of [desiredRoute, runsRoute, madeRoute]) {
    assert.match(src, /^import pool from "@\/lib\/db";$/m);
    assert.match(src, /export const dynamic = "force-dynamic";/);
  }
  // The feed is never cached and is one verb each: no other handler on any path.
  assert.doesNotMatch(desiredRoute, /export async function (POST|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(runsRoute, /export async function (GET|PUT|PATCH|DELETE)\b/);
  assert.doesNotMatch(madeRoute, /export async function (GET|PUT|PATCH|DELETE)\b/);
});

test("END anchors — the route files were read to their last line", () => {
  assert.match(desiredRoute, /env: feedEnv \}\);\s*\}\s*$/);
  assert.match(runsRoute, /secret: process\.env\.STREAM_API_SECRET \}\);\s*\}\s*$/);
  assert.match(madeRoute, /return madePostResponse\(req, \{ db: pool, secret: process\.env\.STREAM_API_SECRET \}\);\s*\}\s*$/);
});
