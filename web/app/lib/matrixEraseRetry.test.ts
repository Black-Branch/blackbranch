// A2-06: a deleted account whose Matrix half failed is not left to an operator who is never told.
// The site retries the Matrix erase (matrixEraseRetry.ts) until it lands, and the Doctor counts the
// ones still waiting. Executed with an injectable query and erase, and its SQL on the real schema
// (SQL_PARSE_DATABASE_URL — a replayed throwaway database; CI sets it; never prod).
// Run: node --test app/lib/matrixEraseRetry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { retryPendingMatrixErasures, PENDING_MATRIX_ERASE_SQL, PENDING_MATRIX_ERASE_COUNT_SQL, type RetryDeps } from "./matrixEraseRetry.ts";

type Row = { matrix_id: string; site_erased_at: Date | null; matrix_erased_at: Date | null; matrix_error: string | null };

function table(rows: Row[]) {
  const t = new Map(rows.map((r) => [r.matrix_id, { ...r }]));
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql === PENDING_MATRIX_ERASE_SQL) {
      return { rows: [...t.values()].filter((r) => r.matrix_error !== null && r.matrix_erased_at === null && r.site_erased_at !== null).map((r) => ({ matrix_id: r.matrix_id })) };
    }
    if (/^UPDATE site\.account_deletions SET matrix_erased_at = now\(\), matrix_error = NULL WHERE matrix_id = \$1$/.test(sql)) {
      const r = t.get(params[0] as string); if (r) { r.matrix_erased_at = new Date(); r.matrix_error = null; }
      return { rows: [] };
    }
    if (/^UPDATE site\.account_deletions SET matrix_error = \$2 WHERE matrix_id = \$1$/.test(sql)) {
      const r = t.get(params[0] as string); if (r) r.matrix_error = params[1] as string;
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { t, query };
}

const pending = (id: string, error = "unreachable"): Row => ({ matrix_id: id, site_erased_at: new Date(), matrix_erased_at: null, matrix_error: error });

function deps(q: ReturnType<typeof table>["query"], erase: RetryDeps["erase"]): RetryDeps {
  return { query: q, erase, log: () => {} };
}

test("a pending Matrix erase that now succeeds is finished: erased_at set, error cleared", async () => {
  const db = table([pending("@a:site.test"), { ...pending("@done:site.test"), matrix_erased_at: new Date(), matrix_error: null }]);
  const asked: string[] = [];
  const out = await retryPendingMatrixErasures(deps(db.query, async (id) => { asked.push(id); return { ok: true }; }));
  assert.deepEqual(asked, ["@a:site.test"], "only the pending one is asked about");
  assert.deepEqual(out, { finished: 1, stillPending: 0 });
  assert.ok(db.t.get("@a:site.test")?.matrix_erased_at);
  assert.equal(db.t.get("@a:site.test")?.matrix_error, null);
});

test("a deletion whose site half has not finished is not touched (the person can still retry it themselves)", async () => {
  const db = table([{ ...pending("@half:site.test"), site_erased_at: null }]);
  const out = await retryPendingMatrixErasures(deps(db.query, async () => assert.fail("asked")));
  assert.deepEqual(out, { finished: 0, stillPending: 0 });
});

test("retry: one that still fails keeps waiting with the newest reason, and a later run finishes it", async () => {
  const db = table([pending("@b:site.test", "unreachable")]);
  let ok = false;
  const erase: RetryDeps["erase"] = async () => (ok ? { ok: true } : { ok: false, code: "not_allowed" });
  assert.deepEqual(await retryPendingMatrixErasures(deps(db.query, erase)), { finished: 0, stillPending: 1 });
  assert.equal(db.t.get("@b:site.test")?.matrix_error, "not_allowed");
  ok = true;
  assert.deepEqual(await retryPendingMatrixErasures(deps(db.query, erase)), { finished: 1, stillPending: 0 });
});

test("an erase that throws counts as still pending and never stops the others", async () => {
  const db = table([pending("@c:site.test"), pending("@d:site.test")]);
  const out = await retryPendingMatrixErasures(deps(db.query, async (id) => { if (id === "@c:site.test") throw new Error("boom"); return { ok: true }; }));
  assert.deepEqual(out, { finished: 1, stillPending: 1 });
});

test("restart: what is pending lives in the table, so a new process picks it up", async () => {
  const db = table([pending("@e:site.test")]);
  const fresh = await import(`./matrixEraseRetry.ts?restart=${Date.now()}`) as typeof import("./matrixEraseRetry.ts");
  assert.deepEqual(await fresh.retryPendingMatrixErasures(deps(db.query, async () => ({ ok: true }))), { finished: 1, stillPending: 0 });
});

test("the pending query and its writes on Postgres", async (t) => {
  const url = process.env.SQL_PARSE_DATABASE_URL || "";
  if (!url) {
    assert.ok(!process.env.CI, "SQL_PARSE_DATABASE_URL must be set in CI");
    t.skip("SQL_PARSE_DATABASE_URL not set");
    return;
  }
  const c = new Client({ connectionString: url });
  await c.connect();
  const ids = ["@a206test-wait:site.test", "@a206test-half:site.test"];
  try {
    await c.query(`DELETE FROM site.account_deletions WHERE matrix_id = ANY($1)`, [ids]);
    await c.query(`INSERT INTO site.account_deletions (matrix_id, site_erased_at, matrix_error) VALUES ($1, now(), 'unreachable'), ($2, NULL, 'unreachable')`, ids);
    const q = (sql: string, params: unknown[] = []) => c.query(sql, params);
    // The Doctor's count is the same predicate: our pending row is counted, the half one is not.
    const before = (await c.query(PENDING_MATRIX_ERASE_COUNT_SQL)).rows[0] as { n: number; codes: string[] };
    assert.ok(before.n >= 1 && before.codes.includes("unreachable"), JSON.stringify(before));
    const out = await retryPendingMatrixErasures({ query: q, erase: async () => ({ ok: true }), log: () => {} });
    // Other rows on the database may be pending too; ours is finished and the half one untouched.
    assert.ok(out.finished >= 1);
    const { rows } = await c.query(`SELECT matrix_id, matrix_erased_at IS NOT NULL AS done, matrix_error FROM site.account_deletions WHERE matrix_id = ANY($1) ORDER BY matrix_id`, [ids]);
    assert.deepEqual(rows, [
      { matrix_id: "@a206test-half:site.test", done: false, matrix_error: "unreachable" },
      { matrix_id: "@a206test-wait:site.test", done: true, matrix_error: null },
    ]);
  } finally {
    await c.query(`DELETE FROM site.account_deletions WHERE matrix_id = ANY($1)`, [ids]);
    await c.end();
  }
});

test("the retry starts at boot, and the viewer is told what actually happens (no promise of a person who is never told)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stripComments } = await import("./testSource.ts");
  const boot = stripComments(readFileSync(join(import.meta.dirname, "../../instrumentation.ts"), "utf8"));
  assert.match(boot, /const \{ startMatrixEraseRetry \} = await import\("@\/app\/lib\/matrixEraseRetry"\);\s*startMatrixEraseRetry\(\);/);
  const rawUi = readFileSync(join(import.meta.dirname, "../components/DeleteAccount.tsx"), "utf8");
  const ui = stripComments(rawUi);
  assert.match(ui, /export default function DeleteAccount|export function DeleteAccount/, "vacuity: the component was read");
  assert.doesNotMatch(ui, /removed by (the site's|\$\{siteName\(\)\}'s) operator/, "the old promise is gone");
  assert.equal((ui.match(/\$\{MATRIX_RETRY_LINE\}/g) ?? []).length, 2, "both the confirm screen and the result say it");
  assert.match(ui, /const MATRIX_RETRY_LINE = "the site keeps trying every hour until it is, and its operator is shown it until then\.";/);
});
