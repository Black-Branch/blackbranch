import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { storePricing } from "@/app/lib/storePricingServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/points — the Points screen's price table: every store item with its stored
// size in streams and its price, plus E. ADMIN ONLY (the public price list is /api/store/prices;
// this adds the streams behind each price).
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const [rows, e] = await Promise.all([storePricing.getPriceRows(), storePricing.getE()]);
  return Response.json({ rows, e }, { headers: { "Cache-Control": "no-store" } });
}
