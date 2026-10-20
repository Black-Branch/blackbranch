import type { Pool } from "pg";

// Shared "rewrite a priority column to 1..N in the given order" transaction.
//
// Extracted from api/mod/embed/route.ts when the community loop-video playlist
// needed the identical operation. It is short but NOT trivial — the rescue pass
// below fixes a bug that permanently corrupted the ordering, and re-deriving it
// from scratch a second time is exactly how that bug comes back.

/**
 * Tables this may rewrite. A closed union, not a string: the table name is
 * interpolated into SQL and must never be able to come from a request.
 */
export type PriorityTable = "site.community_embeds" | "site.community_loop_videos";

/**
 * Set `priority` = 1..N following `ids`, in one transaction.
 *
 * Two passes, because there is no unique constraint to shuffle against and a
 * one-pass update would transiently collide: park every positive priority in the
 * negative range, then assign the requested order.
 */
export async function reorderByPriority(
  pool: Pool,
  table: PriorityTable,
  ids: number[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE ${table} SET priority = -priority WHERE priority > 0`);
    await client.query(
      `UPDATE ${table} e SET priority = v.pos
         FROM unnest($1::int[], $2::int[]) AS v(id, pos)
        WHERE e.id = v.id`,
      [ids, ids.map((_, i) => i + 1)],
    );
    // Rescue anything the payload did not mention.
    //
    // Load-bearing. The parking pass negates EVERY positive priority, but only
    // the submitted ids get restored — so a row missing from the payload (a stale
    // client list, a concurrent insert, a partial drag) would be left negative
    // forever. Rows are read ORDER BY priority ASC, so those stranded rows would
    // sort AHEAD of everything, permanently pinned to the top with no UI path to
    // fix it.
    //
    // Append them after the explicit order, preserving their previous relative
    // order — negation reversed it, so DESC on the negative value restores it.
    await client.query(
      `WITH leftovers AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY priority DESC) AS rn
           FROM ${table}
          WHERE priority < 0
       )
       UPDATE ${table} e
          SET priority = $1::int + l.rn
         FROM leftovers l
        WHERE e.id = l.id`,
      [ids.length],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
