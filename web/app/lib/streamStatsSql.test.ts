// The Stream tab's SQL through the runtime driver, against a real replayed schema: seeded
// sessions, snapshots, chat and payments come back grouped, counted and summed. One transaction,
// rolled back — the replayed CI database is left as it was.
// Run: SQL_PARSE_DATABASE_URL=postgres://… node --test app/lib/streamStatsSql.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { loadGroups, loadSessions, loadSessionDetail, loadLiveDashboard, liveFromDatabase, type Query } from "./streamStatsSql.ts";

const URL = process.env.SQL_PARSE_DATABASE_URL || "";

test("the loaders group, count and sum seeded rows; money only with income", async (t) => {
  if (!URL) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI — see the sql-parse job");
    t.skip("SQL_PARSE_DATABASE_URL not set (local run without a throwaway Postgres)");
    return;
  }
  const db = new Client({ connectionString: URL });
  await db.connect();
  // One query at a time on one client (the loaders fire theirs together).
  let chain: Promise<unknown> = Promise.resolve();
  const q: Query = (sql, params) => {
    const run = chain.then(() => db.query(sql, params as unknown[]));
    chain = run.catch(() => {});
    return run;
  };
  try {
    await db.query("BEGIN");
    // Nothing else in this transaction: start from empty stream tables.
    await db.query("DELETE FROM stream.support_events; DELETE FROM stream.chat_log; DELETE FROM stream.viewer_snapshots; DELETE FROM stream.sessions");
    await db.query("INSERT INTO stream.users (id, name) VALUES ('u1', 'casey') ON CONFLICT (id) DO NOTHING");
    // Stream A: two segments 3 min apart (one logical stream), 2 h, ended a day ago.
    await db.query(`INSERT INTO stream.sessions (stream_id, started_at, ended_at) VALUES
      ('t-a1', now() - interval '26 hours', now() - interval '25 hours'),
      ('t-a2', now() - interval '25 hours' + interval '3 minutes', now() - interval '24 hours'),
      ('t-blip', now() - interval '40 hours', now() - interval '40 hours' + interval '1 minute'),
      ('t-live', now() - interval '30 minutes', NULL)`);
    await db.query(`INSERT INTO stream.viewer_snapshots (stream_id, twitch, youtube, kick, streamplace, recorded_at) VALUES
      ('t-a1', 10, 5, NULL, 0, now() - interval '26 hours' + interval '1 minute'),
      ('t-a1', 20, 5, 1, 0, now() - interval '25 hours' - interval '1 minute'),
      ('t-a2', 30, 10, 0, 2, now() - interval '24 hours' - interval '1 minute'),
      ('t-blip', 1, 0, 0, 0, now() - interval '40 hours'),
      ('t-live', 7, 3, 0, 0, now() - interval '1 minute')`);
    const chat = (id: string, ago: string, bot = false) =>
      db.query(`INSERT INTO stream.chat_log (stream_id, user_id, platform, username, message, is_bot, created_at)
                VALUES ($1, 'u1', 'twitch', 'casey', 'hi', $2, now() - $3::interval)`, [id, bot, ago]);
    await chat("t-a1", "25 hours 30 minutes");
    await chat("t-a2", "24 hours 30 minutes");
    await chat("t-a2", "24 hours 20 minutes", true);
    await chat("t-live", "2 minutes");
    await db.query(`INSERT INTO stream.support_events (user_id, platform, username, amount_usd, event_type, stream_id, created_at) VALUES
      ('u1', 'twitch', 'casey', 2.50, 'sub', 't-a1', now() - interval '25 hours 30 minutes'),
      ('u1', 'native', 'casey', 5.00, NULL, 't-a2', now() - interval '24 hours 30 minutes'),
      ('u1', 'native', 'casey', 1.00, 'sticker', 't-a2', now() - interval '24 hours 29 minutes'),
      ('u1', 'kofi', 'casey', 3.00, 'donation', NULL, now() - interval '20 hours'),
      ('u1', 'twitch', 'casey', 4.00, 'bits', 't-live', now() - interval '5 minutes')`);

    const groups = await loadGroups(q);
    assert.deepEqual(groups.map((g) => g.streamIds), [["t-live"], ["t-a1", "t-a2"], ["t-blip"]]);

    const list = await loadSessions(q, { income: true, sort: "date", limit: 100 });
    assert.deepEqual(list.map((s) => s.streamId), ["t-live", "t-a1"], "the blip is hidden, the live stream is listed");
    const a = list[1]!;
    assert.equal(a.segments, 2);
    assert.equal(a.peakViewers, 42);
    assert.equal(a.messages, 2, "the bot's line is not counted");
    assert.equal(a.earnedCents, 750, "the sticker paid in points is not income; the NULL-type payment is");

    const noMoney = await loadSessions(q, { income: false, sort: "earned", limit: 100 });
    assert.ok(noMoney.every((s) => s.earnedCents === null));

    const d = await loadSessionDetail(q, "t-a2", true, Date.now());
    assert.ok(d, "any member id opens the whole stream");
    assert.equal(d.summary.streamId, "t-a1");
    assert.equal(d.curve.length, 3);
    assert.equal(d.curve[1]!.kick, 1);
    assert.equal(d.chat.reduce((n, p) => n + p.count, 0), 2);
    assert.equal(d.income?.earnedCents, 750);
    assert.deepEqual(d.income?.byPlatform, { native: 500, twitch: 250 });
    assert.equal(d.income?.events.length, 2);
    assert.equal(d.income?.offStreamCents, 0, "the Ko-fi tip came after this stream ended");
    assert.equal((await loadSessionDetail(q, "t-a1", false, Date.now()))?.income, null);
    assert.equal(await loadSessionDetail(q, "nope", true, Date.now()), null);

    const live = await liveFromDatabase(q);
    assert.ok(live.live && live.streamId === "t-live" && live.viewers?.total === 10);
    const dash = await loadLiveDashboard(q, "t-live", Date.now(), true);
    assert.equal(dash.curve.length, 1);
    assert.equal(dash.velocity.length, 30);
    assert.equal(dash.velocity.reduce((n, b) => n + b.total, 0), 1);
    assert.equal(dash.income?.earnedCents, 400);
    assert.equal(dash.income?.offStreamCents, 300, "the Ko-fi tip arrived between the two streams");
    assert.equal((await loadLiveDashboard(q, "t-live", Date.now(), false)).income, null);
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
});
