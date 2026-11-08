import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireMod } from "@/app/lib/admin";
import { openMarks, markOf } from "@/app/lib/userMarks";
import { marksForViewer } from "@/app/lib/modTargets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mod/marks                       — every open suspicious mark (mod panel, chat badge)
// GET /api/mod/marks?matrixId=…|canonicalId=… — one person's open mark with its evidence (usercard)
// MODS ONLY, checked here. Marks never appear in a public frame or route. A mod never sees a mark on
// themselves (modTargets.ts marksForViewer — the Reports list's rule); an admin sees every one.
export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  const q = (sql: string, params: unknown[]) => pool.query(sql, params);
  let admin: boolean;
  try {
    admin = (await pool.query<{ is_admin: boolean }>(`SELECT is_admin FROM site.users WHERE matrix_id = $1`, [mod])).rows[0]?.is_admin === true;
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }
  const viewer = { id: mod, admin };
  const matrixId = req.nextUrl.searchParams.get("matrixId");
  const canonicalId = req.nextUrl.searchParams.get("canonicalId");
  try {
    if (matrixId || canonicalId) {
      const one = await markOf({ matrixId, canonicalId });
      const [shown] = one ? await marksForViewer([one], viewer, q) : [];
      return Response.json({ mark: shown ?? null }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ marks: await marksForViewer(await openMarks(), viewer, q) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return new Response("Moderation check unavailable — try again shortly", { status: 503, headers: { "Retry-After": "5" } });
  }
}
