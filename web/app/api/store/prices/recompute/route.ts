import { requireAdmin } from "@/app/lib/admin";
import { storePricing } from "@/app/lib/storePricingServer";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/store/prices/recompute { e, apply? } → { e, current, changes }
//
// Sets E — the Qorm a median engaged viewer earns per stream — and re-renders
// every store price against it. Admin only: it changes what everyone is
// charged.
//
// TWO-STEP BY DESIGN. Without `apply: true` this is a DRY RUN that writes
// nothing and returns exactly what would move. The UI shows that list and makes
// the admin confirm it. A one-shot "set E to 50" control would silently reprice
// nine items on a typo, and the damping means the number you type is NOT the
// number you get — so seeing the actual moves first is the difference between
// a considered change and a surprise.
//
// Preview and apply run through the same pure planner (planRecompute), so the
// list shown cannot disagree with the write it is previewing.
export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => null);
  const e = Math.round(Number((body as { e?: unknown } | null)?.e));
  // Bounded, not merely positive. E is Qorm-per-stream for one viewer: single
  // digits make the whole store cost pennies, and four digits make a sticker
  // cost more than anyone holds. Both are typos, not intentions.
  if (!Number.isFinite(e) || e < 5 || e > 500) {
    return Response.json({ error: "bad_e", min: 5, max: 500 }, { status: 400 });
  }

  const apply = (body as { apply?: unknown } | null)?.apply === true;
  const current = await storePricing.getE();
  const changes = apply
    ? await storePricing.recomputeStorePrices(e)
    : await storePricing.previewRecompute(e);

  return Response.json({ e, current, applied: apply, changes });
}
