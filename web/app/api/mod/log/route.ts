import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { NextRequest } from "next/server";
import { failedByBatch } from "@/app/lib/modPropagation";

// GET ?before=<id>&limit=<n>[&offset=<n>][&q=<text>][&from=<iso>&to=<iso>] — the site moderation history
// (site.mod_log), newest-first for the mod panel. The panel's Mod history shows 8, then 16, then
// pages of 16 (offset), and searches (q: action, target, target's name, mod, mod's name, reason).
// `before` (cursor) still works for any other reader. Rows carrying a batch_id (purges)
// expand client-side into their platform_mod_actions via
// /api/mod/platform-actions?batchId=…; other rows expand by targetId.
export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const sp = req.nextUrl.searchParams;
  const before = Number(sp.get("before")) || null;
  const limit = Math.min(Math.max(Number(sp.get("limit")) || 30, 1), 100);
  const offset = Math.min(Math.max(Math.floor(Number(sp.get("offset")) || 0), 0), 100_000);
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  // from/to (ISO): the actions inside a time span — the Chat history shows them in its stream.
  // An unparseable bound is ignored.
  const iso = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const from = iso(sp.get("from"));
  const to = iso(sp.get("to"));

  const params: unknown[] = [limit, offset];
  const where: string[] = [];
  if (before) { params.push(before); where.push(`l.id < $${params.length}`); }
  if (from) { params.push(from); where.push(`l.created_at >= $${params.length}::timestamptz`); }
  if (to) { params.push(to); where.push(`l.created_at <= $${params.length}::timestamptz`); }
  if (q) {
    params.push(q);
    const n = params.length;
    where.push(`(l.action ILIKE '%' || $${n}::text || '%' OR l.target_id ILIKE '%' || $${n}::text || '%'
      OR COALESCE(tu.display_name, '') ILIKE '%' || $${n}::text || '%' OR l.performed_by ILIKE '%' || $${n}::text || '%'
      OR COALESCE(mu.display_name, '') ILIKE '%' || $${n}::text || '%' OR COALESCE(l.reason, '') ILIKE '%' || $${n}::text || '%')`);
  }

  const { rows } = await pool.query(
    `SELECT l.id, l.action, l.target_id, l.performed_by, l.duration_minutes,
            l.expires_at, l.reason, l.batch_id, l.created_at,
            tu.display_name AS target_name, mu.display_name AS mod_name
     FROM site.mod_log l
     LEFT JOIN site.users tu ON tu.matrix_id = l.target_id
     LEFT JOIN site.users mu ON mu.matrix_id = l.performed_by
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY l.id DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  // The platforms each row's action failed on (✗ on the row) — rows with a batch only.
  const failed = await failedByBatch((sql, p) => pool.query(sql, p), rows.map((r) => r.batch_id).filter(Boolean))
    .catch(() => new Map<string, string[]>());

  return Response.json({
    entries: rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      targetId: r.target_id,
      targetName: r.target_name,
      performedBy: r.performed_by,
      modName: r.mod_name,
      durationMinutes: r.duration_minutes,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      reason: r.reason,
      batchId: r.batch_id,
      failedPlatforms: r.batch_id ? failed.get(String(r.batch_id)) ?? [] : [],
      at: new Date(r.created_at).toISOString(),
    })),
    nextBefore: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  });
}
