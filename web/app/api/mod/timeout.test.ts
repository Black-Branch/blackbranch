// The mods' one Timeout (spec 2026-10-23 §4.11): POST /api/mod/timeout writes the timed site ban that
// the community reconciler turns into level −1 in every room, then asks for a run; DELETE lifts it.
// A fake db answers the handler's statements; the same handlers then run on a real Postgres
// (SQL_PARSE_DATABASE_URL, each test inside BEGIN … ROLLBACK).
// Run: env -u DATABASE_URL node --test app/api/mod/timeout.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { timeoutPostResponse, timeoutDeleteResponse, type TimeoutDeps } from "../../lib/community/modTimeout.ts";
import { requestReconcile } from "../../lib/community/reconcileRequest.ts";
import { TIMEOUT_CHOICES } from "../../lib/community/timeoutChoices.ts";
import { LIFT_BAN_SQL } from "../../lib/community/unbans.ts";
import { checkModerationCeiling } from "../../lib/modCeiling.ts";
import { stripComments } from "../../lib/sourceText.mjs";

const MOD = "@mod:example.test";
const TARGET = "@troll:example.test";

type Call = { sql: string; params: unknown[] };
type Answer = (sql: string, params: unknown[]) => object[] | undefined;

function harness(answer: Answer = () => undefined, over: Partial<TimeoutDeps> = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  const deps: TimeoutDeps = {
    db: { query: async <R extends object>(sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      events.push("db");
      return { rows: (answer(sql, params) ?? []) as R[] };
    } },
    mod: MOD,
    ceiling: async () => { events.push("ceiling"); return null; },
    log: async (e) => { events.push(`log:${e.action}`); },
    pushChat: async (b) => { events.push(`push:${b.lift ? "lift" : "set"}`); },
    fanOut: () => { events.push("fanOut"); return ["twitch"]; },
    fanOutLift: () => { events.push("fanOutLift"); return ["twitch"]; },
    reconcile: async () => { events.push("reconcile"); return true; },
    batchId: () => "batch-1",
    ...over,
  };
  return { deps, calls, events };
}

const req = (body: unknown, method = "POST") => new Request("http://x/api/mod/timeout", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
const UNTIL = new Date("2026-10-23T12:10:00Z");
const writes = (calls: Call[]) => calls.filter((c) => /INSERT|DELETE|UPDATE/.test(c.sql));

test("rejects an unlisted duration", async () => {
  for (const minutes of [0, 5, 30, 2, 10081, -1, "10", null, 1.5]) {
    const h = harness();
    const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes, reason: "spam" }), h.deps));
    assert.equal(r.status, 400, String(minutes));
    assert.equal(r.body.error, "Choose how long: 1 minute, 10 minutes, 1 hour, 1 day or 1 week.");
    assert.equal(h.calls.length, 0, "nothing read or written");
    assert.ok(!h.events.includes("reconcile"));
  }
  assert.deepEqual(TIMEOUT_CHOICES.map((c) => c.minutes), [1, 10, 60, 1440, 10080]);
});

test("requires a reason", async () => {
  for (const reason of [undefined, "", "   ", 5, "x".repeat(201)]) {
    const h = harness();
    const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason }), h.deps));
    assert.equal(r.status, 400, JSON.stringify(reason));
    assert.equal(r.body.error, "Write a reason, up to 200 characters.");
    assert.equal(h.calls.length, 0);
  }
  const h = harness(() => [{ expires_at: UNTIL }]);
  assert.equal((await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "x".repeat(200) }), h.deps)).status, 200, "200 characters is allowed");
});

test("writes expires_at and requests reconcile", async () => {
  const h = harness((sql) => (/INSERT INTO site\.bans/.test(sql) ? [{ expires_at: UNTIL }] : undefined));
  const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "  spam  " }), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, applied: true, until: UNTIL.toISOString(), batchId: "batch-1", platforms: ["twitch"] });
  const w = writes(h.calls);
  assert.equal(w.length, 1, "one statement writes the row");
  assert.match(w[0]!.sql, /INSERT INTO site\.bans \(matrix_id, banned_by, reason, expires_at\) VALUES \(\$1, \$2, \$3, now\(\) \+ make_interval\(mins => \$4::int\)\)/);
  assert.deepEqual(w[0]!.params, [TARGET, MOD, "spam", 10, "batch-1"]);
  // The ceiling first; the row; then the record, the chat path, the platforms; the reconciler last.
  assert.deepEqual(h.events, ["ceiling", "db", "log:timeout", "push:set", "fanOut", "reconcile"]);
});

test("refuses to shorten a ban into a timeout", async () => {
  const h = harness((sql) => (/SELECT expires_at FROM site\.bans/.test(sql) ? [{ expires_at: null }] : undefined));
  const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 60, reason: "spam" }), h.deps));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "That person is banned.");
  assert.ok(!h.events.includes("reconcile") && !h.events.includes("fanOut") && !h.events.some((e) => e.startsWith("log")));
});

test("a longer timeout already running is kept, and nothing else happens", async () => {
  const LATER = new Date("2026-10-30T12:00:00Z");
  const h = harness((sql) => (/SELECT expires_at FROM site\.bans/.test(sql) ? [{ expires_at: LATER }] : undefined));
  const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 1, reason: "spam" }), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, applied: false, until: LATER.toISOString() });
  assert.deepEqual(h.events, ["ceiling", "db", "db"]);
});

test("the moderation ceiling refuses before anything is read or written", async () => {
  const h = harness(undefined, { ceiling: async () => new Response("Forbidden", { status: 403 }) });
  const res = await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "spam" }), h.deps);
  assert.equal(res.status, 403);
  assert.equal(h.calls.length, 0);
});

test("no person, yourself, or a name that is not an account: refused in words", async () => {
  for (const userId of [undefined, "", "troll", "!room:example.test"]) {
    const r = await read(await timeoutPostResponse(req({ userId, minutes: 10, reason: "spam" }), harness().deps));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Choose who to time out.");
  }
  const self = await read(await timeoutPostResponse(req({ userId: MOD, minutes: 10, reason: "spam" }), harness().deps));
  assert.equal(self.status, 400);
  assert.equal(self.body.error, "You cannot time yourself out.");
  const fk = harness(() => { throw Object.assign(new Error("fk"), { code: "23503" }); });
  const r = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "spam" }), fk.deps));
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "That isn't an account on this site.");
  const down = harness(() => { throw new Error("connection refused"); }, { logError: () => {} });
  const d = await read(await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "spam" }), down.deps));
  assert.equal(d.status, 503);
  assert.equal(d.body.error, "The timeout could not be saved. Try again.");
});

test("DELETE lifts a running timeout and asks for a run; it records no unban (a timeout never made a room ban)", async () => {
  const h = harness((sql) => (/WITH gone AS/.test(sql) ? [{ lifted: 1, banned: false }] : undefined));
  const r = await read(await timeoutDeleteResponse(req({ userId: TARGET }, "DELETE"), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, lifted: true, batchId: "batch-1", platforms: ["twitch"] });
  const w = writes(h.calls);
  assert.equal(w.length, 1);
  assert.match(w[0]!.sql, /DELETE FROM site\.bans WHERE matrix_id = \$1 AND expires_at > now\(\)/, "only a running timeout, never a ban");
  assert.doesNotMatch(w[0]!.sql, /community_unbans/, "a lifted timeout must not release a room ban");
  assert.deepEqual(w[0]!.params, [TARGET, MOD, "batch-1"]);
  assert.deepEqual(h.events, ["ceiling", "db", "log:unban", "push:lift", "fanOutLift", "reconcile"]);
});

test("DELETE on a ban refuses; the Unban action lifts a ban", async () => {
  const h = harness(() => [{ lifted: 0, banned: true }]);
  const r = await read(await timeoutDeleteResponse(req({ userId: TARGET }, "DELETE"), h.deps));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "That person is banned.");
  assert.ok(!h.events.includes("reconcile"));
});

test("retry: lifting a timeout that is already gone answers ok and does nothing more", async () => {
  const h = harness(() => [{ lifted: 0, banned: false }]);
  const r = await read(await timeoutDeleteResponse(req({ userId: TARGET }, "DELETE"), h.deps));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, lifted: false });
  assert.deepEqual(h.events, ["ceiling", "db"]);
});

test("a run is asked only while the install has the reconciler; a failed ask never fails the timeout", async () => {
  let asked = 0;
  const ask = async () => { asked++; return { ok: true as const, requestedAt: "2026-10-23T12:00:00Z" }; };
  assert.equal(await requestReconcile(false, ask), false);
  assert.equal(asked, 0, "off: the host is not asked");
  assert.equal(await requestReconcile(true, ask), true);
  assert.equal(asked, 1);
  assert.equal(await requestReconcile(true, async () => ({ ok: false as const, error: "no drop box" })), false);
  assert.equal(await requestReconcile(true, async () => { throw new Error("disk full"); }), false);
  const h = harness((sql) => (/INSERT INTO site\.bans/.test(sql) ? [{ expires_at: UNTIL }] : undefined), { reconcile: async () => false });
  assert.equal((await timeoutPostResponse(req({ userId: TARGET, minutes: 10, reason: "spam" }), h.deps)).status, 200);
});

// ── The same handlers on a real Postgres ──────────────────────────────────────────────────────────
const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const id = (name: string) => `@cmtyto-${name}:example.test`;

async function connect(t: { skip: (m: string) => void }): Promise<Client | null> {
  if (!DB_URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return null;
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  return db;
}

/** The real statements write the batch id onto linked canonicals' rows (a uuid column). */
const REAL_BATCH = "00000000-0000-4000-8000-00000000000b";
function realDeps(db: Client): TimeoutDeps {
  return {
    db, mod: id("mod"), ceiling: async () => null, log: async () => {}, pushChat: async () => {},
    fanOut: () => [], fanOutLift: () => [], reconcile: async () => true, batchId: () => REAL_BATCH,
  };
}

test("restart: on real Postgres the row is the whole state — a fresh connection reads the timeout, a longer one wins, a ban is never shortened", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2), ($3)`, [id("mod"), id("troll"), id("gone")]);
    const deps = realDeps(db);
    const post = async (who: string, minutes: number) => read(await timeoutPostResponse(req({ userId: who, minutes, reason: "spam" }), deps));
    const ten = await post(id("troll"), 10);
    assert.equal(ten.status, 200);
    assert.equal(ten.body.applied, true);
    const row = async () => (await db.query<{ expires_at: Date; reason: string; banned_by: string }>(
      `SELECT expires_at, reason, banned_by FROM site.bans WHERE matrix_id = $1`, [id("troll")])).rows;
    const first = await row();
    assert.equal(first.length, 1);
    const minutesLeft = (first[0]!.expires_at.getTime() - Date.now()) / 60_000;
    assert.ok(minutesLeft > 9 && minutesLeft <= 10.1, `expires_at is now + 10 minutes (${minutesLeft})`);
    assert.equal(first[0]!.reason, "spam");
    assert.equal(first[0]!.banned_by, id("mod"));

    // A shorter one does not shorten it; a longer one replaces it.
    const one = await post(id("troll"), 1);
    assert.deepEqual([one.status, one.body.applied, one.body.until], [200, false, first[0]!.expires_at.toISOString()]);
    const day = await post(id("troll"), 1440);
    assert.equal(day.body.applied, true);
    assert.ok((await row())[0]!.expires_at.getTime() > first[0]!.expires_at.getTime() + 23 * 3_600_000);

    // A permanent ban is never turned into a timeout.
    await db.query(`UPDATE site.bans SET expires_at = NULL WHERE matrix_id = $1`, [id("troll")]);
    const banned = await post(id("troll"), 10080);
    assert.deepEqual([banned.status, banned.body.error], [409, "That person is banned."]);
    assert.equal((await row())[0]!.expires_at, null);

    // Not an account: the foreign key answers, in words. The savepoint keeps the transaction usable.
    await db.query("SAVEPOINT nobody");
    const nobody = await post(id("nobody"), 10);
    await db.query("ROLLBACK TO SAVEPOINT nobody");
    assert.deepEqual([nobody.status, nobody.body.error], [404, "That isn't an account on this site."]);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("lifting_a_timeout_logs_no_unban (retry: the same lift again answers ok; a ban is refused)", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2), ($3)`, [id("mod"), id("quiet"), id("gone")]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $3, now() + interval '1 hour'), ($2, $3, NULL)`,
      [id("quiet"), id("gone"), id("mod")]);
    const deps = realDeps(db);
    const lift = async (who: string) => read(await timeoutDeleteResponse(req({ userId: who }, "DELETE"), deps));
    const unbans = async (who: string) => (await db.query<{ lifted_by: string }>(
      `SELECT lifted_by FROM site.community_unbans WHERE matrix_id = $1`, [who])).rows;

    assert.deepEqual((await lift(id("quiet"))).body, { ok: true, lifted: true, batchId: REAL_BATCH, platforms: [] });
    assert.equal((await db.query(`SELECT 1 FROM site.bans WHERE matrix_id = $1`, [id("quiet")])).rows.length, 0);
    assert.deepEqual(await unbans(id("quiet")), [], "a timeout never made a room ban: its lift releases none");
    assert.deepEqual((await lift(id("quiet"))).body, { ok: true, lifted: false });
    assert.deepEqual(await unbans(id("quiet")), []);

    const ban = await lift(id("gone"));
    assert.deepEqual([ban.status, ban.body.error], [409, "That person is banned."]);
    assert.equal((await db.query(`SELECT 1 FROM site.bans WHERE matrix_id = $1`, [id("gone")])).rows.length, 1, "the ban stands");
    assert.equal((await unbans(id("gone"))).length, 0);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("a mod timing out Staff is refused 403 by the route's ceiling (real Postgres); an admin may, and nothing is written for the mod", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id, is_mod, is_staff, is_admin) VALUES ($1, true, false, false), ($2, false, true, false), ($3, false, false, true)`,
      [id("mod"), id("staffer"), id("admin")]);
    const q = (sql: string, params: unknown[]) => db.query(sql, params) as never;
    const as = (actor: string): TimeoutDeps => ({ ...realDeps(db), mod: actor, ceiling: (a, target) => checkModerationCeiling(a, target, q) });
    const post = (actor: string) => timeoutPostResponse(req({ userId: id("staffer"), minutes: 10, reason: "spam" }), as(actor));
    const refused = await post(id("mod"));
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /^Only an admin can moderate a member of staff$/);
    assert.equal((await db.query(`SELECT 1 FROM site.bans WHERE matrix_id = $1`, [id("staffer")])).rows.length, 0, "nothing written");
    const lift = await timeoutDeleteResponse(req({ userId: id("staffer") }, "DELETE"), as(id("mod")));
    assert.equal(lift.status, 403, "lifting is held to the same ceiling");
    assert.equal((await post(id("admin"))).status, 200, "an admin may time out Staff");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("lifting_a_ban_logs_an_unban: the ban route's lift records a permanent ban once; a timeout lifted the same way records nothing", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO site.users (matrix_id) VALUES ($1), ($2), ($3), ($4)`, [id("mod"), id("gone"), id("quiet"), id("served")]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $4, NULL), ($2, $4, now() + interval '1 hour'), ($3, $4, now() - interval '1 hour')`,
      [id("gone"), id("quiet"), id("served"), id("mod")]);
    const unbans = async (who: string) => (await db.query<{ lifted_by: string }>(
      `SELECT lifted_by FROM site.community_unbans WHERE matrix_id = $1`, [who])).rows;
    for (const who of [id("gone"), id("quiet"), id("served")]) await db.query(LIFT_BAN_SQL, [who, id("mod"), randomUUID()]);
    const left = await db.query(`SELECT matrix_id FROM site.bans WHERE matrix_id = ANY($1)`, [[id("gone"), id("quiet"), id("served")]]);
    assert.equal(left.rows.length, 0, "every row is lifted");
    assert.deepEqual(await unbans(id("gone")), [{ lifted_by: id("mod") }], "a permanent ban's lift is recorded");
    assert.deepEqual(await unbans(id("quiet")), [], "a running timeout's lift is not");
    assert.deepEqual(await unbans(id("served")), [], "an ended timeout's row is not");
    await db.query(LIFT_BAN_SQL, [id("gone"), id("mod"), randomUUID()]);
    assert.equal((await unbans(id("gone"))).length, 1, "retry: lifting again records nothing new");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("the route wires the ceiling before the platforms, and the ban route records its lifts and asks for a run", () => {
  const read = (p: string) => {
    const raw = readFileSync(join(import.meta.dirname, p), "utf8");
    return stripComments(raw);
  };
  const route = read("timeout/route.ts");
  for (const verb of ["POST", "DELETE"]) {
    const body = route.slice(route.indexOf(`export async function ${verb}`));
    assert.match(body, /const mod = await requireMod\(\);\s*if \(mod instanceof Response\) return mod;/, verb);
  }
  assert.match(route, /ceiling: \(actor, target\) => assertCanModerateAccount\(actor, target\)/);
  assert.match(route, /reconcile: \(\) => requestReconcile\(\)/);
  const ban = read("ban/route.ts");
  const post = ban.slice(ban.indexOf("export async function POST"), ban.indexOf("export async function DELETE"));
  const lift = ban.slice(ban.indexOf("export async function DELETE"));
  assert.match(post, /for \(const t of targets\) results\.push\(await banAccount\(t, action\)\);[\s\S]*await requestReconcile\(\);/);
  assert.match(lift, /await pool\.query\(LIFT_BAN_SQL, \[t, mod, batchId\]\);/);
  // The ceiling over every linked canonical, for every account, before the first write (round 6).
  for (const [verb, region, write] of [["POST", post, "results.push(await banAccount("], ["DELETE", lift, "await pool.query(LIFT_BAN_SQL,"]] as const) {
    const guard = region.indexOf("const denied = await assertCanModerateAccount(mod, account);");
    assert.ok(guard > 0 && guard < region.indexOf(write), `${verb}: the account-and-canonicals ceiling does not come before the write`);
    assert.ok(region.indexOf(write) > 0, `${verb}: the write was not found`);
  }
  assert.doesNotMatch(lift, /DELETE FROM site\.bans/, "the lift goes through the statement that records it");
  assert.match(lift, /await requestReconcile\(\);\s*return Response\.json\(\{ ok: true, batchId, platforms: \[\.\.\.platforms\] \}\);\s*\}\s*$/, "vacuity: the end of the file was read");
});

test("a moderator granted or removed (/mod, /unmod, the card, the panel: all through setmod) asks for a run", () => {
  const route = stripComments(readFileSync(join(import.meta.dirname, "setmod/route.ts"), "utf8"));
  const post = route.slice(route.indexOf("export async function POST"));
  assert.match(post, /if \(result === "changed"\) \{\s*await appendModLog\([^)]*\);\s*await requestReconcile\(\);\s*\}/, "a change, and only a change, asks");
  assert.match(post, /return Response\.json\(\{ ok: true, changed: result === "changed" \}\);\s*\}\s*$/, "vacuity: the end of the file was read");
  const commands = readFileSync(join(import.meta.dirname, "..", "..", "lib", "commands", "run.ts"), "utf8");
  assert.equal((commands.match(/modFetch\("\/api\/mod\/setmod"/g) ?? []).length, 2, "/mod and /unmod go through the same route");
});
