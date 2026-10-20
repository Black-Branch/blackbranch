import pool from "@/lib/db";
import { NATIVE_SQL } from "@/app/lib/nativePlatform";

// Social credit = sum of votes received on all of a person's messages, across
// every chat identity that belongs to them:
//   - native messages    → site.chat_messages keyed by matrix_id
//   - platform messages  → stream.chat_log keyed by canonical stream id
// Identity bridges: stream.links (the native rows map matrix_id ↔
// canonical) and site.platform_links (account linking).

export type IdentitySet = { matrixIds: string[]; canonicalIds: string[] };

export async function resolveIdentities({
  matrixId,
  canonicalId,
}: {
  matrixId?: string | null;
  canonicalId?: string | null;
}): Promise<IdentitySet> {
  const matrixIds = new Set<string>(matrixId ? [matrixId] : []);
  const canonicalIds = new Set<string>(canonicalId ? [canonicalId] : []);

  if (matrixIds.size > 0) {
    const { rows } = await pool.query(
      `SELECT canonical AS id FROM stream.links
       WHERE platform IN ${NATIVE_SQL} AND platform_id = ANY($1)
       UNION
       SELECT canonical_id FROM site.platform_links WHERE matrix_id = ANY($1)`,
      [[...matrixIds]]
    );
    rows.forEach((r) => canonicalIds.add(r.id));
  }
  if (canonicalIds.size > 0) {
    const { rows } = await pool.query(
      `SELECT platform_id AS id FROM stream.links
       WHERE platform IN ${NATIVE_SQL} AND canonical = ANY($1)
       UNION
       SELECT matrix_id FROM site.platform_links WHERE canonical_id = ANY($1)`,
      [[...canonicalIds]]
    );
    rows.forEach((r) => matrixIds.add(r.id));
  }
  return { matrixIds: [...matrixIds], canonicalIds: [...canonicalIds] };
}

/** `platform`: count only that platform's lines of the canonicals (one identity's credit — what a
 *  stranger may see without the person's cross-platform link, /api/user/credit). */
export async function getSocialCredit(ids: IdentitySet, platform: string | null = null): Promise<number> {
  // chat_log's native mirror rows are excluded — native votes are
  // keyed on site.chat_messages ids, not the mirror's chat_log ids.
  // Forum votes (site.forum_votes, migrate-v37) are stored with the event
  // author's matrix id, so they sum directly by matrix identity.
  const { rows } = await pool.query(
    `SELECT COALESCE((
        SELECT SUM(v.vote) FROM site.message_votes v
        JOIN site.chat_messages m ON v.platform IN ${NATIVE_SQL} AND v.message_id = m.id
        WHERE m.matrix_id = ANY($1)
      ), 0) + COALESCE((
        SELECT SUM(v.vote) FROM site.message_votes v
        JOIN stream.chat_log cl ON v.platform = cl.platform AND v.message_id = cl.id
        WHERE cl.user_id = ANY($2) AND cl.platform NOT IN ${NATIVE_SQL}
          AND ($3::text IS NULL OR lower(cl.platform) = $3)
      ), 0) + COALESCE((
        SELECT SUM(fv.vote) FROM site.forum_votes fv
        WHERE fv.author_matrix_id = ANY($1)
      ), 0) AS credit`,
    [ids.matrixIds, ids.canonicalIds, platform ? platform.toLowerCase() : null]
  );
  return Number(rows[0].credit);
}
