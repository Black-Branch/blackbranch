import { getHistory } from "@/app/lib/coinsServer";
import { requireUser } from "@/app/lib/authGuard";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// GET /api/points/history[?beforeId=N] → { rows, hasMore }
// The signed-in user's own coin ledger, newest first (transparency: every
// credit and debit is visible, nothing is obscured). Keyset-paged on id.
export async function GET(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const beforeRaw = req.nextUrl.searchParams.get("beforeId");
  const beforeId = beforeRaw && /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : undefined;
  const rows = await getHistory(matrixId, beforeId);
  return Response.json({ rows, hasMore: rows.length >= 50 });
}
