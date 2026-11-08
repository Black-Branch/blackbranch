// The reconciler's feed and run log against a real Postgres: the SQL the fake in
// desiredServer.test.ts accepts unread (column names, the entitlement fragment's parameter, the
// one-statement insert-and-trim) runs here on the tables the migrations made.
//
// Every write is inside a transaction that is rolled back.
//
// Run locally against a throwaway database built by the chain (never the prod DATABASE_URL):
//   ./migrations/replay-into.sh "postgres://…/cmty_scratch"
//   env -u DATABASE_URL SQL_PARSE_DATABASE_URL=postgres://…/cmty_scratch node --test app/lib/community/desiredServer.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { buildDesiredFeed, insertRun, madePostResponse, parseRun, runPostResponse, type FeedEnv } from "./desiredServer.ts";
import { GRACE_DAYS, withGrace } from "../subscriptions/grace.ts";

const DB_URL = process.env.SQL_PARSE_DATABASE_URL || "";
const id = (name: string) => `@cmtyfeed-${name}:example.test`;

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

const ENV: FeedEnv = {
  serverName: "example.test", serviceUserId: id("service"), readerUserId: id("reader"), hubRoomId: null,
  streamerId: id("streamer"), botIds: [id("bot")], sources: ["stripe"], putBack: true, retentionCapDays: 365, bridgeAccounts: [],
};

test("the feed over real tables: levels, entitlement (record, trial, gift, lapsed), bans and the hidden accounts", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    const users: [string, string][] = [
      ["admin", "is_admin"], ["staff", "is_staff"], ["mod", "is_mod"], ["both", "is_staff, is_mod"], ["botflag", "is_bot"],
      ["service", "is_admin"], ["reader", "is_bot"], ["gone", "is_mod"], ["quiet", "is_mod"], ["served", "is_mod"],
      ["fan", ""], ["trial", ""], ["gifted", ""], ["lapsed", ""], ["deleted", "is_admin"],
    ];
    for (const [name, flags] of users) {
      const cols = flags ? `, ${flags}` : "";
      const vals = flags ? `, ${flags.split(",").map(() => "true").join(", ")}` : "";
      await db.query(`INSERT INTO site.users (matrix_id${cols}) VALUES ($1${vals})`, [id(name)]);
    }
    await db.query(`UPDATE site.users SET deleted_at = now() WHERE matrix_id = $1`, [id("deleted")]);
    const record = (who: string, status: string, providerStatus: string, accessUntil: string | null) =>
      db.query(`INSERT INTO site.subscription_records (provider, external_id, matrix_id, tier, status, provider_status, access_until, source_event_at)
                VALUES ('stripe', $1, $2, 'supporter', $3, $4, $5, now())`, [`cmtyfeed-${who}`, id(who), status, providerStatus, accessUntil]);
    await record("fan", "active", "active", null);
    await record("trial", "active", "trialing", null);
    await record("lapsed", "ended", "canceled", null);
    await db.query(`INSERT INTO site.gift_subscriptions (stripe_session_id, recipient_matrix_id, months, starts_at, expires_at)
                    VALUES ('cmtyfeed-gift', $1, 1, now() - interval '10 days', now() + interval '20 days')`, [id("gifted")]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $3, NULL), ($2, $3, now() + interval '1 hour'), ($4, $3, now() - interval '1 hour')`,
      [id("gone"), id("quiet"), id("admin"), id("served")]);

    const feed = await buildDesiredFeed(db, ENV);
    const mine = (s: string) => s.startsWith("@cmtyfeed-");
    assert.deepEqual(feed.people.filter((p) => mine(p.userId)), [
      { userId: id("admin"), level: 100 },
      { userId: id("bot"), level: 50 },
      { userId: id("botflag"), level: 50 },
      { userId: id("both"), level: 75 },
      { userId: id("mod"), level: 50 },
      { userId: id("quiet"), level: 50 },
      { userId: id("served"), level: 50 },
      { userId: id("staff"), level: 75 },
      { userId: id("streamer"), level: 100 },
    ]);
    assert.deepEqual(feed.supporters.filter(mine), [id("bot"), id("fan"), id("gifted"), id("streamer"), id("trial")],
      "a Stripe trial entitles; a lapsed record does not; a gift does");
    assert.deepEqual(feed.banned.filter(mine), [id("gone")]);
    assert.deepEqual(feed.timedOut.filter((x) => mine(x.userId)).map((x) => x.userId), [id("quiet")]);
    assert.ok(Date.parse(feed.timedOut.find((x) => x.userId === id("quiet"))!.until) > Date.now());
    assert.deepEqual(feed.hiddenUserIds, [id("service"), id("reader")]);
    assert.ok(feed.roles.length >= 7, "the ladder is read (or filled) in the same call");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

const DAY = 86_400_000;

/** A Stripe record whose last reported period ended `endedDaysAgo` days ago, its access end the
 *  billing code's own (stripeRecords.ts: withGrace(period end)): an end event that never arrived. */
async function staleRecord(db: Client, who: string, endedDaysAgo: number, status = "active") {
  const periodEnd = new Date(Date.now() - endedDaysAgo * DAY);
  await db.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [id(who)]);
  await db.query(`INSERT INTO site.subscription_records (provider, external_id, matrix_id, tier, status, provider_status, period_end, access_until, source_event_at)
                  VALUES ('stripe', $1, $2, 'supporter', $3, $3, $4, $5, now())`, [`cmtyfeed-${who}`, id(who), status, periodEnd, withGrace(periodEnd)]);
}

test("lapsed_after_grace_is_not_a_supporter", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await staleRecord(db, "lapsed", GRACE_DAYS + 1);
    const feed = await buildDesiredFeed(db, ENV);
    assert.ok(!feed.supporters.includes(id("lapsed")), `the period ended ${GRACE_DAYS + 1} days ago, past the ${GRACE_DAYS} grace days`);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("entitled_in_grace_still_supporter", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await staleRecord(db, "late", GRACE_DAYS - 1, "past_due");
    const feed = await buildDesiredFeed(db, ENV);
    assert.ok(feed.supporters.includes(id("late")), `the period ended ${GRACE_DAYS - 1} days ago, inside the grace days`);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("lapse_during_timeout_keeps_timeout (real tables): out of the supporters, still timed out", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    await staleRecord(db, "quietfan", GRACE_DAYS + 1);
    await db.query(`INSERT INTO site.users (matrix_id) VALUES ($1)`, [id("mod")]);
    await db.query(`INSERT INTO site.bans (matrix_id, banned_by, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [id("quietfan"), id("mod")]);
    const feed = await buildDesiredFeed(db, ENV);
    assert.ok(!feed.supporters.includes(id("quietfan")));
    assert.deepEqual(feed.timedOut.filter((x) => x.userId.startsWith("@cmtyfeed-")).map((x) => x.userId), [id("quietfan")]);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("retry: posting runs past 50 keeps the newest 50, and each post answers its own id", async (t) => {
  const db = await connect(t);
  if (!db) return;
  try {
    await db.query("BEGIN");
    const parsed = parseRun({ mode: "report", startedAt: "2026-10-23T12:00:00Z", finishedAt: "2026-10-23T12:00:01Z", ok: false,
      drift: [{ room: "general", field: "topic" }], applied: null, error: "timed out" });
    assert.ok(parsed.ok);
    const ids: number[] = [];
    for (let i = 0; i < 55; i++) ids.push(await insertRun(db, parsed.run));
    assert.equal(new Set(ids).size, 55);
    const { rows } = await db.query<{ id: number; drift: unknown; applied: unknown; ok: boolean }>(
      `SELECT id, drift, applied, ok FROM site.community_runs ORDER BY id`);
    assert.equal(rows.length, 50);
    assert.deepEqual(rows.map((r) => Number(r.id)), ids.slice(-50));
    assert.deepEqual(rows.at(-1)!.drift, [{ room: "general", field: "topic" }], "stored as jsonb, read back as the list");
    assert.equal(rows.at(-1)!.applied, null);
    assert.equal(rows.at(-1)!.ok, false);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("two phases: a run's row is there, unfinished, from its start; the finish fills that row once", async (t) => {
  const db = await connect(t);
  if (!db) return;
  const SECRET = "runs-db-test-secret";
  const post = async (body: Record<string, unknown>) => {
    const r = await runPostResponse(new Request("http://site.test/api/internal/community/runs", {
      method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${SECRET}` },
    }), { db, secret: SECRET, log: { error: () => {} } });
    return { status: r.status, body: (await r.json()) as { id?: number } };
  };
  try {
    await db.query("BEGIN");
    const start = await post({ mode: "apply", startedAt: "2026-10-23T12:00:00Z" });
    assert.equal(start.status, 200);
    const id = start.body.id!;
    const row = async () => (await db.query<{ finished_at: Date | null; ok: boolean | null; applied: unknown }>(
      `SELECT finished_at, ok, applied FROM site.community_runs WHERE id = $1`, [id])).rows[0]!;
    assert.equal((await row()).finished_at, null, "in progress: the delete guard sees it");
    const fin = await post({ id, finishedAt: "2026-10-23T12:00:09Z", ok: true, drift: [], applied: [{ op: "rename", said: "rename #a to #b" }], error: null });
    assert.deepEqual(fin, { status: 200, body: { id } });
    const done = await row();
    assert.equal(new Date(done.finished_at!).toISOString(), "2026-10-23T12:00:09.000Z");
    assert.equal(done.ok, true);
    assert.deepEqual(done.applied, [{ op: "rename", said: "rename #a to #b" }]);
    // Retry: the same finish again finds no unfinished row: 409, the row unchanged.
    assert.equal((await post({ id, finishedAt: "2026-10-23T12:05:00Z", ok: false, drift: [], applied: [], error: "x" })).status, 409);
    assert.equal((await row()).ok, true);
    assert.equal((await db.query(`SELECT 1 FROM site.community_runs WHERE id = $1`, [id])).rows.length, 1, "one row for the run");
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});

test("restart: a room the reconciler made is recorded on its row once; a changed row or a taken id is refused", async (t) => {
  const db = await connect(t);
  if (!db) return;
  const SECRET = "made-db-test-secret";
  const made = (body: Record<string, unknown>) => madePostResponse(new Request("http://site.test/api/internal/community/made", {
    method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${SECRET}` },
  }), { db, secret: SECRET, log: { error: () => {} } });
  try {
    await db.query("BEGIN");
    const hub = (await db.query<{ id: number }>(`INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id)
      VALUES ('hub', 'Hub', 'a0', '!cmtyhub:example.test') RETURNING id`)).rows[0]!.id;
    const room = (await db.query<{ id: number }>(`INSERT INTO site.community_rooms (space_id, kind, name, order_key)
      VALUES ($1, 'text', 'events', 'a1') RETURNING id`, [hub])).rows[0]!.id;
    const gate = (await db.query<{ id: number }>(`INSERT INTO site.community_spaces (kind, name, order_key, matrix_room_id)
      VALUES ('gate', 'Supporters', 'a2', '!cmtygone:example.test') RETURNING id`)).rows[0]!.id;
    const idOf = async (table: string, rowId: number) =>
      (await db.query<{ matrix_room_id: string | null }>(`SELECT matrix_room_id FROM site.community_${table} WHERE id = $1`, [rowId])).rows[0]!.matrix_room_id;

    // A new row: recorded. The same post again (a retry after the answer was lost) finds the row
    // already naming another room than "none", so it is refused, and the row keeps the first id.
    assert.equal((await made({ table: "rooms", id: room, matrixRoomId: "!cmtymade1:example.test", replaces: null })).status, 200);
    assert.equal(await idOf("rooms", room), "!cmtymade1:example.test");
    assert.equal((await made({ table: "rooms", id: room, matrixRoomId: "!cmtymade2:example.test", replaces: null })).status, 409);
    assert.equal(await idOf("rooms", room), "!cmtymade1:example.test");
    // A space that was gone: its new room replaces the old id.
    assert.equal((await made({ table: "spaces", id: gate, matrixRoomId: "!cmtymade3:example.test", replaces: "!cmtygone:example.test" })).status, 200);
    assert.equal(await idOf("spaces", gate), "!cmtymade3:example.test");
    // A room id another row already has: the unique column refuses it, answered as 409.
    const other = (await db.query<{ id: number }>(`INSERT INTO site.community_rooms (space_id, kind, name, order_key)
      VALUES ($1, 'text', 'clips', 'a3') RETURNING id`, [hub])).rows[0]!.id;
    await db.query("SAVEPOINT taken");
    assert.equal((await made({ table: "rooms", id: other, matrixRoomId: "!cmtymade1:example.test", replaces: null })).status, 409);
    await db.query("ROLLBACK TO SAVEPOINT taken");
    assert.equal(await idOf("rooms", other), null);
    // A row that is gone.
    assert.equal((await made({ table: "rooms", id: 2_000_000_000, matrixRoomId: "!cmtymade4:example.test", replaces: null })).status, 409);
  } finally {
    await db.query("ROLLBACK");
    await db.end();
  }
});
