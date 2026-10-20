// Who is viewing, as the server knows it: mod/admin flags + canonical stream
// identity (powers "My stats" in the user menu) in ONE round-trip rather than
// two parallel queries per signed-in home load. Independent subselects, not a
// JOIN: the canonical must survive a missing site.users row. Shared by the
// home page and /terminal, so the terminal's page knows the viewer exactly as
// the chat page does.
// The canonical answers the ONE-preferred question (a display read: "My stats"), through the one
// tie-break (canonicalFromMatrix.ts) — never a permission check.
// Relative imports, so the split-identity test can run it against a throwaway database.
import type { Pool } from "pg";
import pool from "../../lib/db.ts";
import { canonicalFromMatrixSql } from "./canonicalFromMatrix.ts";

export type UserContext = { is_mod: boolean; is_admin: boolean; canonicalId: string | null };

export const NO_USER: UserContext = { is_mod: false, is_admin: false, canonicalId: null };

export async function getUserContext(matrixId: string, db: Pick<Pool, "query"> = pool): Promise<UserContext> {
  try {
    const { rows } = await db.query(
      `SELECT
         COALESCE((SELECT is_mod   FROM site.users WHERE matrix_id = $1), false) AS is_mod,
         COALESCE((SELECT is_admin FROM site.users WHERE matrix_id = $1), false) AS is_admin,
         ${canonicalFromMatrixSql("$1")} AS canonical`,
      [matrixId]
    );
    const row = rows[0] ?? {};
    return {
      is_mod: !!row.is_mod,
      is_admin: !!row.is_admin,
      canonicalId: (row.canonical as string | null) ?? null,
    };
  } catch {
    return NO_USER;
  }
}
