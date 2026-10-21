import { NATIVE_SQL } from "./nativePlatform.ts";
// A canonical stream id (12 hex — stream.users.id, the identity a platform
// chatter resolves to) versus a matrix id (a site account). The two are not
// interchangeable, and handing one where the other is expected fails only at
// the database: awarding upvote points to a platform message's AUTHOR — a
// canonical id read from stream.chat_log.user_id — as if it were a matrix id
// violates `coin_earn_stream_matrix_id_fkey`, and linked people are silently
// owed points.
//
// The query is injected so the rule is testable without the pg pool (the same
// reason chatIdentity's tests mirror its policy).

const CANONICAL_RE = /^[0-9a-f]{12}$/i;

export type LinkQuery = (
  sql: string, params: unknown[]
) => Promise<{ rows: { matrix_id: string }[] }>;

/**
 * EVERY site account a canonical id belongs to — [] for an unlinked chatter
 * (no account — nothing keyed on matrix_id can be written for them). A matrix
 * id passes straight through as [id].
 *
 * Two places tie a canonical to an account, and both are read:
 *   - site.platform_links — identity linking (a platform account linked to a
 *     site account), listed first;
 *   - stream.links on the site's own platform — the account's OWN canonical,
 *     the one its native chat is logged under (and that native chat frames
 *     carry publicly). Reading only platform_links made an owner who never
 *     linked a platform account look like an unlinked chatter to the
 *     moderation ceiling.
 *
 * A failed lookup THROWS: use this where "unlinked" would grant something
 * (the moderation ceiling), so an outage can never read as "not the owner".
 */
export async function linkedMatrixIds(id: string, query: LinkQuery): Promise<string[]> {
  if (!CANONICAL_RE.test(id)) return [id];
  const { rows } = await query(
    `SELECT matrix_id FROM (
       SELECT matrix_id, 0 AS src FROM site.platform_links WHERE canonical_id = $1
       UNION ALL
       SELECT platform_id AS matrix_id, 1 AS src FROM stream.links
        WHERE platform IN ${NATIVE_SQL} AND canonical = $1
     ) ids ORDER BY src`,
    [id.toLowerCase()]
  );
  return [...new Set(rows.map((r) => r.matrix_id).filter((m): m is string => typeof m === "string" && m !== ""))];
}

/**
 * The one account to credit for a canonical (the first linkedMatrixIds finds),
 * for callers where unlinked means "skip": never throws, a lookup hiccup reads
 * as "unlinked".
 */
export async function matrixIdForCanonical(id: string, query: LinkQuery): Promise<string | null> {
  return linkedMatrixIds(id, query).then((ids) => ids[0] ?? null, () => null);
}
