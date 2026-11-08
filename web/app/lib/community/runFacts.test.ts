// The community's run log as the doctor's facts (config/doctor.mjs rows community.drift and
// community.lastRun): the newest run and the newest finished one, as counts and a clock time in
// the site's own zone — never a run's error text, which can name rooms and the server.
// The SQL against real tables: runFacts.db.test.ts. Run: env -u DATABASE_URL node --test app/lib/community/runFacts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { communityRunFacts, clockOf } from "./runFacts.ts";

type Row = { mode: string; started_at: Date; finished_at: Date | null; ok: boolean | null; put_back: number; left_as_is: number; warns: unknown };

function fakeDb(latest: Row | null, finished: Row | null, fail = 0) {
  const calls: string[] = [];
  let failing = fail;
  return {
    calls,
    query: async <R extends object>(sql: string): Promise<{ rows: R[] }> => {
      calls.push(sql);
      if (failing > 0) { failing--; throw new Error("connection terminated"); }
      if (/finished_at IS NOT NULL/.test(sql)) return { rows: (finished ? [finished] : []) as R[] };
      return { rows: (latest ? [latest] : []) as R[] };
    },
  };
}
const row = (over: Partial<Row> = {}): Row => ({ mode: "apply", started_at: new Date("2026-10-09T23:50:00Z"), finished_at: new Date("2026-10-09T23:51:00Z"),
  ok: true, put_back: 0, left_as_is: 0, warns: {}, ...over });

test("the newest run and the newest finished one, as the doctor reads them", async () => {
  const db = fakeDb(row({ finished_at: null, ok: null, started_at: new Date("2026-10-10T00:05:00Z") }), row({ put_back: 3 }));
  const f = await communityRunFacts(db, { timeZone: null });
  assert.deepEqual(f, {
    latest: { mode: "apply", startedAt: "2026-10-10T00:05:00.000Z", finishedAt: null, ok: null, putBack: 0, left: 0, warns: {}, clock: "00:05 UTC" },
    lastFinished: { mode: "apply", startedAt: "2026-10-09T23:50:00.000Z", finishedAt: "2026-10-09T23:51:00.000Z", ok: true, putBack: 3, left: 0, warns: {}, clock: "23:51 UTC" },
  });
  // Every statement only reads, and none carries the run's error text or its entries out.
  for (const sql of db.calls) {
    assert.match(sql, /^\s*SELECT /);
    assert.doesNotMatch(sql, /\berror\b|said/);
  }
  // What counts: an entry the run put back (putBack true) in `applied`; anything in `drift` that is
  // not a note (op warn) was found and left.
  assert.match(db.calls[0]!, /e->>'putBack' = 'true'/);
  assert.match(db.calls[0]!, /COALESCE\(e->>'op', ''\) <> 'warn'/);
});

test("warns are counted by code; anything that is not a fixed-word code with a whole count is dropped", async () => {
  const db = fakeDb(row(), row({ warns: { cannot_read: 2, no_hub_access: 1, "Bad Code!": 3, invite_ignored: "x", zero: 0 } }));
  const f = await communityRunFacts(db, { timeZone: null });
  assert.deepEqual(f?.lastFinished?.warns, { cannot_read: 2, no_hub_access: 1 });
  assert.match(db.calls[0]!, /e->>'op' = 'warn' AND e->>'code' ~ '\^\[a-z_\]\{1,40\}\$'/);
  assert.deepEqual((await communityRunFacts(fakeDb(row({ warns: null }), null), { timeZone: null }))?.latest?.warns, {});
});

test("the clock is the site's own zone; unset (or a zone the runtime does not know) is UTC and says so", () => {
  assert.equal(clockOf("2026-10-09T23:51:00Z", "Europe/Berlin"), "01:51");
  assert.equal(clockOf("2026-10-09T23:51:00Z", null), "23:51 UTC");
  assert.equal(clockOf("2026-10-09T23:51:00Z", "Not/AZone"), "23:51 UTC");
  assert.equal(clockOf("2026-10-09T09:05:00Z", "UTC"), "09:05");
});

test("no runs yet: both null; a database that did not answer: null facts (the rows go grey, never red)", async () => {
  assert.deepEqual(await communityRunFacts(fakeDb(null, null), { timeZone: null }), { latest: null, lastFinished: null });
  assert.equal(await communityRunFacts(fakeDb(row(), row(), 1), { timeZone: null }), null);
});

test("retry: the same log read twice gives the same facts", async () => {
  const db = fakeDb(row(), row({ left_as_is: 2, mode: "report" }));
  const a = await communityRunFacts(db, { timeZone: "Europe/Berlin" });
  const b = await communityRunFacts(db, { timeZone: "Europe/Berlin" });
  assert.deepEqual(a, b);
  assert.equal(a?.lastFinished?.left, 2);
});
