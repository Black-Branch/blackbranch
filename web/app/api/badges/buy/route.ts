import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { priceGuard } from "@/app/lib/storePricing";
import { notifyBadgesChanged } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";
import { invalidateBadgeSnapshot } from "@/app/lib/badgeCache";

export const runtime = "nodejs";

// POST /api/badges/buy { badgeId, spendId } → { ok, balance }
// Buy a badge UNLOCK with coins (the dormant v60 `unlock_criteria` hook, activated
// v67). Purchasable = unlock_criteria {"type":"coin","price":N}; the subscriber and
// mod badges are never purchasable. Buying unlocks only — the user equips via the
// existing /api/badges/equip flow (and may still need a slot). Debit-then-grant
// with a refund if the grant loses a race — never keep coins for nothing.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const badgeId = Number((body as { badgeId?: unknown } | null)?.badgeId);
  const rawSpend = (body as { spendId?: unknown } | null)?.spendId;
  const spendId = typeof rawSpend === "string" ? rawSpend.slice(0, 64) : "";
  if (!Number.isInteger(badgeId) || badgeId <= 0 || spendId.length < 8) {
    return new Response("Bad Request", { status: 400 });
  }

  const { rows } = await pool.query<{
    criteria: { type?: string; price?: number } | null;
    is_subscriber: boolean;
    is_mod: boolean;
    unlocked: boolean;
  }>(
    `SELECT b.unlock_criteria AS criteria, b.is_subscriber, b.is_mod,
            EXISTS (SELECT 1 FROM site.badge_unlocks u
                     WHERE u.matrix_id = $2 AND u.badge_id = b.id) AS unlocked
     FROM site.badges b WHERE b.id = $1`,
    [badgeId, matrixId]
  );
  const badge = rows[0];
  if (!badge) return new Response("No such badge", { status: 404 });
  const price = badge.criteria?.type === "coin" ? Math.round(Number(badge.criteria.price)) : NaN;
  if (badge.is_subscriber || badge.is_mod || !Number.isFinite(price) || price <= 0) {
    return Response.json({ error: "not_purchasable" }, { status: 409 });
  }
  if (badge.unlocked) return Response.json({ error: "already_unlocked" }, { status: 409 });

  // Shown vs charged: badge prices are admin-repriceable live (unlock_criteria,
  // editable from this very store), so the two-step confirm could arm on one
  // number and debit another. Same guard as every table-priced spend; the
  // "table" here is the badge row.
  const guard = priceGuard((body as { expectedPrice?: unknown } | null)?.expectedPrice, price);
  if (!guard.ok) {
    return Response.json({ error: guard.error, price: guard.price }, { status: guard.status });
  }

  const debit = await debitCoins({
    matrixId, amount: price, sink: "badge", ref: spendId, meta: { badge_id: badgeId },
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });

  const ins = await pool.query(
    `INSERT INTO site.badge_unlocks (matrix_id, badge_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING badge_id`,
    [matrixId, badgeId]
  ).catch(() => ({ rowCount: 0 }));
  if ((ins.rowCount ?? 0) === 0) {
    // Raced an unlock that appeared between the check and the grant — refund.
    await refundCoins({ matrixId, amount: price, ref: spendId, meta: { reason: "already_unlocked" } })
      .catch((e) => console.error("[badges/buy] refund failed:", e));
    return Response.json({ error: "already_unlocked" }, { status: 409 });
  }

  invalidateBadgeSnapshot();
  void notifyBadgesChanged();
  return Response.json({ ok: true, balance: debit.balance });
}
