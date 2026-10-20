import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";

// GET → { matrixIds, complete: true } — EVERY account with an active ban or timeout, no limit.
// The community's room-ban sync (siteBanSync.ts) reads this: it lifts a room ban when an account
// is missing from the list, so the list must be whole — a capped list would let people who are
// still banned back in. `complete` is the sync's proof; anything else reads as partial.
export async function GET() {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  const { rows } = await pool.query<{ matrix_id: string }>(
    `SELECT matrix_id FROM site.bans WHERE expires_at IS NULL OR expires_at > NOW() ORDER BY matrix_id`
  );
  return Response.json({ matrixIds: rows.map((r) => r.matrix_id), complete: true });
}
