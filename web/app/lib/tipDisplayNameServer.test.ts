// web/app/lib/tipDisplayNameServer.test.ts
//
// The RULE, pinned by real execution against a fake pool (not a source
// scan): what display name a tip gets recorded under. Mirrors the donate
// route's rule — extracted so it gets its own unit test, the same reason
// paymentResultServer.ts exists (route.ts imports the @/lib/db alias and
// cannot be executed under node --test at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTipDisplayNameServer } from "./tipDisplayNameServer.ts";

type Row = Record<string, unknown>;
function fakePool(rows: Row[], opts: { throws?: boolean } = {}) {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      seen.push({ sql, params });
      if (opts.throws) throw new Error("connection reset");
      return { rows, rowCount: rows.length };
    },
  };
  return { pool: pool as never, seen };
}

// ─── the four cases the coordinator asked for, each with its own message ──

test("signed out + blank name -> empty, and the database is never touched", async () => {
  const { pool, seen } = fakePool([{ display_name: "should never be read" }]);
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: null, anonymous: false, rawName: "",
  });
  assert.equal(name, "", "a guest with no typed name must get an empty label, never a lookup result");
  assert.equal(seen.length, 0, "no matrixId to look up — the query must not even run for a guest");
});

test("signed in + blank name -> their own site.users.display_name", async () => {
  const { pool, seen } = fakePool([{ display_name: "Rosalind" }]);
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: "abc123", anonymous: false, rawName: "",
  });
  assert.equal(name, "Rosalind", "a signed-in tipper with a blank box must be backfilled with their own site identity — the promise the page's helper line makes");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.sql, /SELECT display_name FROM site\.users WHERE matrix_id = \$1/);
  assert.deepEqual(seen[0]!.params, ["abc123"]);
});

test("signed in + blank name + anonymous -> empty — anonymity wins over the backfill", async () => {
  const { pool, seen } = fakePool([{ display_name: "Rosalind" }]);
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: "abc123", anonymous: true, rawName: "",
  });
  assert.equal(
    name, "",
    "anonymous must suppress the site-name backfill — a tipper who asked to stay anonymous must NEVER be labeled with their own site identity on stream",
  );
  assert.equal(seen.length, 0, "anonymity must short-circuit BEFORE the lookup even runs — not just discard its result");
});

test("signed in + a typed name -> the typed name, never the site name", async () => {
  const { pool, seen } = fakePool([{ display_name: "Rosalind" }]);
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: "abc123", anonymous: false, rawName: "Bob",
  });
  assert.equal(name, "Bob", "a typed name must win over the site name — it must never be silently replaced by the account's display name");
  assert.equal(seen.length, 0, "a typed name is already known — the lookup must not run at all");
});

// ─── the sharper version of "anonymity wins": it must drop even a name that
// was actually typed, not just suppress the backfill of an absent one ──────

test("anonymous with a typed name -> still empty", async () => {
  const { pool, seen } = fakePool([]);
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: "abc123", anonymous: true, rawName: "Bob",
  });
  assert.equal(name, "", "checking anonymous must drop even a name the tipper actually typed, not just an absent one");
  assert.equal(seen.length, 0);
});

// ─── the failure-handling donate/route.ts deliberately has, copied ────────

test("a database hiccup on the lookup falls back to empty, not a thrown error", async () => {
  const { pool, seen } = fakePool([], { throws: true });
  const name = await createTipDisplayNameServer({ pool }).resolveTipDisplayName({
    matrixId: "abc123", anonymous: false, rawName: "",
  });
  assert.equal(
    name, "",
    "a DB failure here must not fail the tip — must fall back to an empty label, same as donate/route.ts's .catch(() => ({ rows: [] }))",
  );
  assert.equal(seen.length, 1);
});
