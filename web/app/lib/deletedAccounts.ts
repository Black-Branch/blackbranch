// Deleted accounts, as sign-in and the session check see them. SERVER ONLY.
//
// A deleted account's still-valid stateless JWT (another device, an old tab) authenticates nothing:
// the session check (siteSession.ts) reads its tombstone on every auth(), and deletion removes every
// site.user_sessions row besides. The deleting request also marks its own account here, so the very
// next request from any of that person's sessions is refused in this process without a query.

import pool from "../../lib/db.ts";

const g = globalThis as unknown as { __deletedAccountsMarked?: Set<string> };
const marked = (g.__deletedAccountsMarked ??= new Set());

/** True once this process has deleted the account (an account is never undeleted). No query. */
export function isMarkedDeleted(matrixId: string): boolean {
  return marked.has(matrixId);
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: { deleted: boolean }[] }>;

/**
 * Sign-in's question, asked by both sign-in callbacks BEFORE they write anything: a deleted account
 * must not get a session row (with its Matrix tokens) on its tombstone. Read fresh, never from the
 * cache: a sign-in is rare and must see a deletion committed a moment ago. A database error
 * THROWS, so the caller refuses the sign-in rather than guessing.
 */
export async function accountDeletedForSignIn(matrixId: string, query: Query = (sql, params) => pool.query(sql, params)): Promise<boolean> {
  const { rows } = await query(`SELECT deleted_at IS NOT NULL AS deleted FROM site.users WHERE matrix_id = $1`, [matrixId]);
  return rows[0]?.deleted === true;
}

/** The deletion marks its own account at once (accountDeletion.ts). */
export function markAccountDeleted(matrixId: string): void {
  marked.add(matrixId);
}
