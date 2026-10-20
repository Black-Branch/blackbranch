import { test } from "node:test";
import assert from "node:assert/strict";
import { createCurrentStream, STREAM_ID_TTL_MS } from "./currentStream.ts";

function fakePool(rowsFor: () => Array<{ stream_id: string }>) {
  let calls = 0;
  const sql: string[] = [];
  return {
    calls: () => calls,
    sql: () => sql,
    pool: {
      query: async (text: string) => {
        calls++;
        sql.push(text);
        return { rows: rowsFor(), rowCount: rowsFor().length };
      },
    } as never,
  };
}

test("returns the open session's stream_id as a number", async () => {
  // `pg` hands BIGINT back as a string; a string stream_id would silently key
  // every earn row differently from the numeric one.
  const { pool } = fakePool(() => [{ stream_id: "1785914794" }]);
  const cs = createCurrentStream({ pool, nowMs: () => 0 });
  assert.equal(await cs.currentStreamId(), 1_785_914_794);
});

test("the query itself selects only an OPEN session", async () => {
  // The "never the most recent stream" rule lives in the SQL, not in the JS
  // around it — a fake pool that ignores the query text cannot see it, so this
  // asserts on the text. Without this, deleting the filter passes every other
  // test in this file.
  const { pool, sql } = fakePool(() => [{ stream_id: "1" }]);
  await createCurrentStream({ pool, nowMs: () => 0 }).currentStreamId();
  assert.match(sql()[0] ?? "", /ended_at IS NULL/,
    "the resolver must select an OPEN session, not merely the newest one");
  assert.match(sql()[0] ?? "", /ORDER BY started_at DESC/,
    "a crashed ingest can leave an older session unclosed; take the newest open one");
});

test("returns null when nothing is live — never the most recent stream", async () => {
  // A fallback to "the last stream" would let a viewer collect the
  // first-message bonus again the moment a stream ends, and keep earning
  // against a stream that is over.
  const { pool } = fakePool(() => []);
  const cs = createCurrentStream({ pool, nowMs: () => 0 });
  assert.equal(await cs.currentStreamId(), null);
});

test("caches within the TTL so a busy chat does not query per message", async () => {
  const { pool, calls } = fakePool(() => [{ stream_id: "42" }]);
  let now = 0;
  const cs = createCurrentStream({ pool, nowMs: () => now });
  assert.equal(await cs.currentStreamId(), 42);
  now = STREAM_ID_TTL_MS - 1;
  assert.equal(await cs.currentStreamId(), 42);
  assert.equal(calls(), 1, "the second read inside the TTL must not hit the database");
});

test("a cached null still expires, so earning starts when a stream begins", async () => {
  // Caching "offline" forever would mean the first minutes of every stream
  // paid nobody, and nothing would ever recover without a deploy.
  let live = false;
  const { pool, calls } = fakePool(() => (live ? [{ stream_id: "7" }] : []));
  let now = 0;
  const cs = createCurrentStream({ pool, nowMs: () => now });
  assert.equal(await cs.currentStreamId(), null);
  live = true;
  now = STREAM_ID_TTL_MS;
  assert.equal(await cs.currentStreamId(), 7);
  assert.equal(calls(), 2);
});

test("a database failure reads as offline rather than throwing", async () => {
  // Every caller is on a fire-and-forget earn path that must never break the
  // action it rewards. Missing an award is recoverable; failing a chat send is
  // not.
  const pool = { query: async () => { throw new Error("db down"); } } as never;
  const cs = createCurrentStream({ pool, nowMs: () => 0 });
  assert.equal(await cs.currentStreamId(), null);
});

test("a failure is not cached as hard as a success", async () => {
  // A thrown query must not pin "offline" for the whole TTL — the next call
  // should try again, or one blip costs a stream's worth of earning.
  let fail = true;
  let calls = 0;
  const pool = {
    query: async () => {
      calls++;
      if (fail) throw new Error("db down");
      return { rows: [{ stream_id: "9" }], rowCount: 1 };
    },
  } as never;
  const cs = createCurrentStream({ pool, nowMs: () => 0 });
  assert.equal(await cs.currentStreamId(), null);
  fail = false;
  assert.equal(await cs.currentStreamId(), 9, "must retry immediately after a failure");
  assert.equal(calls, 2);
});
