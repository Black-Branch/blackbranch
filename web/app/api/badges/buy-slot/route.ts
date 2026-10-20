import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { storePricing } from "@/app/lib/storePricingServer";
import { priceGuard } from "@/app/lib/storePricing";
import { notifyBadgesChanged } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";
import { invalidateBadgeSnapshot } from "@/app/lib/badgeCache";

export const runtime = "nodejs";

// POST /api/badges/buy-slot { spendId, expectedPrice } → { ok, balance, baseSlots }
// Buy a permanent badge slot (base_slots += 1). Base is capped at 2 so the live
// subscription +1 still fits under MAX_SLOTS=3 — and a non-subscriber who buys a
// slot can genuinely wear a badge (no hard paywall on participation). The capped
// UPDATE runs guarded (WHERE base_slots < 2) after the debit; losing that race
// refunds — never keep coins for nothing.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const rawSpend = (body as { spendId?: unknown } | null)?.spendId;
  const spendId = typeof rawSpend === "string" ? rawSpend.slice(0, 64) : "";
  if (spendId.length < 8) return new Response("Bad Request", { status: 400 });

  // Priced from site.store_prices. This route already answers 409 for
  // `max_slots`; the client must branch on `error`, not on the status alone.
  const guard = priceGuard(
    (body as { expectedPrice?: unknown } | null)?.expectedPrice,
    await storePricing.getPrice("badge_slot")
  );
  if (!guard.ok) {
    return Response.json({ error: guard.error, price: guard.price }, { status: guard.status });
  }
  const price = guard.price;

  const { rows } = await pool.query<{ base_slots: number }>(
    `SELECT base_slots FROM site.badge_slots WHERE matrix_id = $1`,
    [matrixId]
  );
  if (Number(rows[0]?.base_slots ?? 0) >= 2) {
    return Response.json({ error: "max_slots" }, { status: 409 });
  }

  const debit = await debitCoins({
    matrixId, amount: price, sink: "badge_slot", ref: spendId, meta: null,
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });

  await pool.query(
    `INSERT INTO site.badge_slots (matrix_id, base_slots, equipped) VALUES ($1, 0, '{}')
     ON CONFLICT (matrix_id) DO NOTHING`,
    [matrixId]
  );
  const upd = await pool.query<{ base_slots: number }>(
    `UPDATE site.badge_slots SET base_slots = base_slots + 1, updated_at = now()
     WHERE matrix_id = $1 AND base_slots < 2
     RETURNING base_slots`,
    [matrixId]
  );
  if ((upd.rowCount ?? 0) === 0) {
    await refundCoins({ matrixId, amount: price, ref: spendId, meta: { reason: "max_slots" } })
      .catch((e) => console.error("[badges/buy-slot] refund failed:", e));
    return Response.json({ error: "max_slots" }, { status: 409 });
  }

  invalidateBadgeSnapshot();
  void notifyBadgesChanged();
  return Response.json({ ok: true, balance: debit.balance, baseSlots: Number(upd.rows[0]?.base_slots ?? 0) });
}
