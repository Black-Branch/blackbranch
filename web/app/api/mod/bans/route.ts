import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { failedByBatch } from "@/app/lib/modPropagation";

// GET — every currently-active ban/timeout, newest first, with display names
// joined for the mod panel's Active bans section. (site.bans holds one row per
// user, so this is naturally small.)
export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const { rows } = await pool.query(
    `SELECT b.matrix_id, b.banned_by, b.reason, b.expires_at, b.created_at,
            tu.display_name AS target_name, mu.display_name AS mod_name
     FROM site.bans b
     LEFT JOIN site.users tu ON tu.matrix_id = b.matrix_id
     LEFT JOIN site.users mu ON mu.matrix_id = b.banned_by
     WHERE b.expires_at IS NULL OR b.expires_at > NOW()
     ORDER BY b.created_at DESC
     LIMIT 200`
  );

  // Each ban's own fan-out: the batch of the newest ban/timeout logged for that person, and the
  // platforms it failed on (✗ on the row).
  const batches = await pool.query<{ target_id: string; batch_id: string }>(
    `SELECT DISTINCT ON (target_id) target_id, batch_id::text AS batch_id
       FROM site.mod_log
      WHERE target_id = ANY($1) AND action IN ('ban', 'timeout') AND batch_id IS NOT NULL
      ORDER BY target_id, id DESC`,
    [rows.map((r) => r.matrix_id)],
  ).catch(() => ({ rows: [] as { target_id: string; batch_id: string }[] }));
  const batchOf = new Map(batches.rows.map((b) => [b.target_id, b.batch_id]));
  const failed = await failedByBatch((sql, p) => pool.query(sql, p), [...batchOf.values()])
    .catch(() => new Map<string, string[]>());

  return Response.json({
    bans: rows.map((r) => ({
      matrixId: r.matrix_id,
      targetName: r.target_name,
      bannedBy: r.banned_by,
      modName: r.mod_name,
      reason: r.reason,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      batchId: batchOf.get(r.matrix_id) ?? null,
      failedPlatforms: failed.get(batchOf.get(r.matrix_id) ?? "") ?? [],
    })),
  });
}
