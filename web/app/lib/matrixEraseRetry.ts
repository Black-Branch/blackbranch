// The Matrix half of "Delete my account", finished later when it failed at the time. SERVER ONLY.
//
// deleteAccount (accountDeletion.ts) erases the site first and the Matrix account last; when the
// account server is down or refuses, the row in site.account_deletions keeps `matrix_error` and the
// person is told the operator removes it. This makes that promise true without waiting on anyone:
// the site retries every pending erase at boot and hourly (eraseMatrixAccount is idempotent — an
// account already deactivated answers ok), and the Doctor's `accounts.matrixErase` row counts the
// ones still waiting, with the fix when it never lands (the site's client lacks the admin grant).
import { eraseMatrixAccount } from "./matrixAccountErase.ts";

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export type RetryDeps = {
  query: Query;
  erase: (matrixId: string) => Promise<{ ok: true } | { ok: false; code: string }>;
  log: (line: string) => void;
};

/** Deletions whose site half finished and whose Matrix half did not — the retry's list and the
 *  Doctor's count (doctorFacts.ts) are this one predicate. */
const PENDING = "FROM site.account_deletions WHERE matrix_error IS NOT NULL AND matrix_erased_at IS NULL AND site_erased_at IS NOT NULL";
/** @test-only exported so the test's table answers this exact statement; the product runs it in
 *  retryPendingMatrixErasures below. */
export const PENDING_MATRIX_ERASE_SQL = `SELECT matrix_id ${PENDING} ORDER BY requested_at LIMIT 100`;
/** The Doctor's fact: how many wait, and their distinct fixed codes (never an account id). */
export const PENDING_MATRIX_ERASE_COUNT_SQL = `SELECT count(*)::int AS n, array_remove(array_agg(DISTINCT matrix_error), NULL) AS codes ${PENDING}`;

/** One retry pass over every pending erase.
 *  @test-only exported so the tests run a pass with an injected query and erase; the product
 *  runs it through startMatrixEraseRetry in this module. */
export async function retryPendingMatrixErasures(deps: RetryDeps): Promise<{ finished: number; stillPending: number }> {
  const { rows } = await deps.query(PENDING_MATRIX_ERASE_SQL);
  let finished = 0;
  let stillPending = 0;
  for (const r of rows as { matrix_id: string }[]) {
    const m = await deps.erase(r.matrix_id).catch(() => ({ ok: false as const, code: "unreachable" }));
    if (m.ok) {
      await deps.query("UPDATE site.account_deletions SET matrix_erased_at = now(), matrix_error = NULL WHERE matrix_id = $1", [r.matrix_id]);
      finished++;
    } else {
      await deps.query("UPDATE site.account_deletions SET matrix_error = $2 WHERE matrix_id = $1", [r.matrix_id, m.code]);
      stillPending++;
    }
  }
  if (finished || stillPending) deps.log(`[account] Matrix erase retry: ${finished} finished, ${stillPending} still waiting`);
  return { finished, stillPending };
}

let started = false;
/** At boot and hourly (instrumentation.ts). Never throws. */
export function startMatrixEraseRetry(): void {
  if (started) return;
  started = true;
  const run = async () => {
    const { default: pool } = await import("../../lib/db.ts");
    await retryPendingMatrixErasures({
      query: (sql, params) => pool.query(sql, params),
      erase: eraseMatrixAccount,
      log: (line) => console.log(line),
    }).catch((e) => console.error("[account] Matrix erase retry failed:", e instanceof Error ? e.message : String(e)));
  };
  void run();
  setInterval(() => void run(), 60 * 60 * 1000).unref?.();
}
