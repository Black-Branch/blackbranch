import { NextRequest } from "next/server";
import { requireMod } from "@/app/lib/admin";
import { openMarks, markOf } from "@/app/lib/userMarks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mod/marks                       — every open suspicious mark (mod panel, chat badge)
// GET /api/mod/marks?matrixId=…|canonicalId=… — one person's open mark with its evidence (usercard)
// MODS ONLY, checked here. Marks never appear in a public frame or route.
export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;
  const matrixId = req.nextUrl.searchParams.get("matrixId");
  const canonicalId = req.nextUrl.searchParams.get("canonicalId");
  if (matrixId || canonicalId) return Response.json({ mark: await markOf({ matrixId, canonicalId }) }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ marks: await openMarks() }, { headers: { "Cache-Control": "no-store" } });
}
