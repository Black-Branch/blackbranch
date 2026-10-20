import { type NextRequest } from "next/server";
import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { storePricing } from "@/app/lib/storePricingServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/admin/points/prices/<item> { baseStreams } — one store item's size in streams; its
// price is re-rendered at the current E in the same transaction. ADMIN ONLY and SAME-ORIGIN ONLY.
// Anyone holding the old price is refused with 409 price_changed on their next spend (the
// expectedPrice guard), never charged a price they were not shown.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ item: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { item } = await params;
  const body = (await req.json().catch(() => null)) as { baseStreams?: unknown } | null;
  const baseStreams = typeof body?.baseStreams === "number" ? body.baseStreams
    : typeof body?.baseStreams === "string" && /^\d+(\.\d+)?$/.test(body.baseStreams.trim()) ? Number(body.baseStreams) : NaN;
  const r = await storePricing.setBaseStreams(decodeURIComponent(item), baseStreams);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  console.log(`[store-prices] ${admin} set ${item}: ${baseStreams} streams, price ${r.from} → ${r.to}`);
  return Response.json({ ok: true, from: r.from, to: r.to }, { headers: { "Cache-Control": "no-store" } });
}
