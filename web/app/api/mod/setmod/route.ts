import pool from "@/lib/db";
import { requireAdmin } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { applyModRole } from "@/app/lib/modRole";
import { NextRequest } from "next/server";

// The moderator role, admin only: `/mod` and `/unmod`, the user card's Make / Remove moderator,
// and the Admin Panel's moderator list. Every change is logged (mod_granted / mod_revoked); the
// owner's client reads the newest of those to give or take community room powers
// (useModPowerSync).

// GET → { moderators: [{ matrixId, displayName, since }] } — the accounts holding the mod role.
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden — admin only", { status: 403 });
  const { rows } = await pool.query<{ matrix_id: string; display_name: string | null; since: Date | null }>(
    `SELECT u.matrix_id, u.display_name,
            (SELECT l.created_at FROM site.mod_log l
              WHERE l.target_id = u.matrix_id AND l.action = 'mod_granted'
              ORDER BY l.id DESC LIMIT 1) AS since
       FROM site.users u
      WHERE u.is_mod AND u.deleted_at IS NULL
      ORDER BY lower(COALESCE(u.display_name, u.matrix_id))`,
  );
  return Response.json({
    moderators: rows.map((r) => ({
      matrixId: r.matrix_id,
      displayName: r.display_name,
      since: r.since ? new Date(r.since).toISOString() : null,
    })),
  });
}

// POST { targetId, grant } → { ok, changed } — grant or remove the role.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden — admin only", { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body) return new Response("Bad Request", { status: 400 });
  const { targetId, grant } = body;
  if (typeof targetId !== "string" || !targetId || typeof grant !== "boolean") {
    return new Response("Bad Request", { status: 400 });
  }

  const result = await applyModRole((sql, p) => pool.query(sql, p), targetId, grant);
  if (result === "not_found") return new Response("User not found", { status: 404 });
  if (result === "changed") {
    await appendModLog({ action: grant ? "mod_granted" : "mod_revoked", target: targetId, by: admin });
  }
  return Response.json({ ok: true, changed: result === "changed" });
}
