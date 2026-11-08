import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { NextRequest } from "next/server";
import { newestActions, standingOf } from "@/app/lib/platformRetry";

// GET /api/mod/platform-actions?targetId=<matrix_id>&batchId=<uuid>&before=<id>&limit=<n>
// Read the cross-platform moderation audit trail (site.platform_mod_actions) —
// the outcomes of fanning bans/timeouts/unbans/deletes/purges out to the
// platforms. Since the fan-out is fire-and-forget (it can't report back on the
// original request), this is how a mod sees whether a platform action actually
// landed. Filters: targetId (UserCard), batchId (mod-panel row expansion);
// `before` (row id) pages the panel's propagation view. Mod-gated.
const RETRYABLE = new Set(["ban", "timeout", "unban"]);

export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const targetId = req.nextUrl.searchParams.get("targetId");
  const batchId = req.nextUrl.searchParams.get("batchId");
  const before = Number(req.nextUrl.searchParams.get("before")) || null;
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 20, 1), 100);

  const where: string[] = [];
  const params: unknown[] = [limit];
  if (targetId) { params.push(targetId); where.push(`target_id = $${params.length}`); }
  if (batchId) { params.push(batchId); where.push(`batch_id = $${params.length}`); }
  if (before) { params.push(before); where.push(`id < $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT id, action, platform, performed_by, target_id, broadcaster_id,
            message_id, duration_seconds, ok, status, detail, acted_via,
            platform_ref, batch_id::text AS batch_id, created_at
     FROM site.platform_mod_actions
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY id DESC
     LIMIT $1`,
    params
  );

  // What a failed ban / timeout / unban row's Retry would meet: superseded rows say by what, and
  // the panel offers no Retry on them (the retry route refuses them too).
  const newest = await newestActions(
    rows.filter((r) => !r.ok && RETRYABLE.has(r.action) && r.target_id).map((r) => r.target_id as string),
    (sql, params) => pool.query(sql, params));
  const supersededBy = (r: { ok: boolean; action: string; target_id: string | null; batch_id: string | null }) => {
    if (r.ok || !RETRYABLE.has(r.action) || !r.target_id) return null;
    const s = standingOf(r, newest.get(r.target_id));
    return s.ok ? null : s.supersededBy;
  };

  return Response.json({
    actions: rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      platform: r.platform,
      performedBy: r.performed_by,
      targetId: r.target_id,
      broadcasterId: r.broadcaster_id,
      messageId: r.message_id,
      durationSeconds: r.duration_seconds,
      ok: r.ok,
      status: r.status,
      detail: r.detail,
      actedVia: r.acted_via,
      batchId: r.batch_id,
      supersededBy: supersededBy(r),
      at: new Date(r.created_at).getTime(),
    })),
  });
}
