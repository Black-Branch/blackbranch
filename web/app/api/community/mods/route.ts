import pool from "@/lib/db";
import { requireAdmin } from "@/app/lib/admin";
import { staffMatrixIds } from "@/app/lib/staff";

// The site's mod list, for the owner's client to reconcile against each channel's power list:
// every account listed here gets mod power, and anyone else listed at mod level loses it
// (useModPowerSync) — except keepIds and a room's bridge bots. This list — site.users — is the role's source of truth; the mod log is only
// its record. Admin-only: nobody else can act on the answer, and the list of who moderates is
// not public information.
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden", { status: 403 });

  const { rows } = await pool.query<{ matrix_id: string }>(
    `SELECT matrix_id FROM site.users WHERE (is_mod OR is_admin) AND deleted_at IS NULL ORDER BY matrix_id`
  );
  // keepIds: the install's own accounts (streamer, bot, extra staff). They hold room power for the
  // install, not as mods, so the reconcile never takes it from them.
  return Response.json({ modIds: rows.map((r) => r.matrix_id), keepIds: [...staffMatrixIds()] });
}
