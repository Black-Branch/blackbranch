import { NATIVE_SQL } from "./nativePlatform.ts";
// The ONE preferred canonical stream id behind a site (Matrix) account — the identity a display
// read shows for that account: its pronouns, its stats card, its popout, "My stats".
//
// Two tables tie a Matrix id to a canonical, and a SPLIT person (the two disagreeing, or several
// platform links on different canonicals) has more than one. This answers ONE question — which
// one to show — with the order stream-api's resolveCanonical documents (identity.js):
//   1. stream.links on the site's own platform (platform_id = the Matrix id): the account's own
//      canonical, the one its native chat is logged under;
//   2. else site.platform_links (matrix_id → canonical_id), the lowest canonical id, so the pick
//      never depends on the query plan.
// It is NOT the answer to "every identity this account is" (permission and consent checks): those
// read every linked canonical (lib/socialCredit.ts resolveIdentities, canonicalIdentity.ts
// linkedMatrixIds, linkConsent.ts). Never collapse the two.
//
// Profile reads key on the canonical (/api/user/[id] → stream-api /user/lookup). Canonical ids stay
// on the server: public chat frames and history carry public ids (publicIdServer.ts), and a route
// that needs the canonical behind a site line resolves it here.
//
// Dependency-free on purpose (an `@/` alias import breaks node --test) so the test can import it.

/**
 * SQL fragment resolving a Matrix id to its ONE preferred canonical stream id, or NULL when the
 * account has no stream presence at all.
 *
 * `matrixIdExpr` must be a developer-written SQL expression (a column reference like
 * `m.matrix_id`, or a bind placeholder like `$1`) — NEVER user input; it is interpolated verbatim.
 */
export function canonicalFromMatrixSql(matrixIdExpr: string): string {
  return `COALESCE(
    (SELECT canonical FROM stream.links
      WHERE platform IN ${NATIVE_SQL} AND platform_id = ${matrixIdExpr}
      ORDER BY canonical LIMIT 1),
    (SELECT canonical_id FROM site.platform_links
      WHERE matrix_id = ${matrixIdExpr} ORDER BY canonical_id LIMIT 1))`;
}

export type CanonicalQuery = (sql: string, params: unknown[]) => Promise<{ rows: { canonical: string | null }[] }>;

/** The ONE preferred canonical for a Matrix id (canonicalFromMatrixSql), or null. A failed read
 *  is null: callers use it for display, where "no stream identity" is the safe answer. */
export async function preferredCanonical(matrixId: string, query: CanonicalQuery): Promise<string | null> {
  try {
    const { rows } = await query(`SELECT ${canonicalFromMatrixSql("$1")} AS canonical`, [matrixId]);
    return rows[0]?.canonical ?? null;
  } catch {
    return null;
  }
}
