import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { debitCoins, refundCoins } from "@/app/lib/coinsServer";
import { priceGuard } from "@/app/lib/storePricing";
import { styleById, forSale } from "@/app/lib/usernameStyles";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// POST /api/points/spend/style { styleId, spendId } → { ok, balance }
// Buy a username-style unlock (migrate-v68). Buying unlocks only — equip via
// PATCH /api/me/style. Debit-then-grant, refund on a lost race.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const body = await req.json().catch(() => null);
  const styleId = typeof (body as { styleId?: unknown } | null)?.styleId === "string"
    ? (body as { styleId: string }).styleId : "";
  const rawSpend = (body as { spendId?: unknown } | null)?.spendId;
  const spendId = typeof rawSpend === "string" ? rawSpend.slice(0, 64) : "";
  const style = styleById(styleId);
  // A retired style stays with its owners but is no longer sold.
  if (!style || !forSale(style) || spendId.length < 8) return new Response("Bad Request", { status: 400 });

  const owned = await pool.query(
    `SELECT 1 FROM site.user_style_unlocks WHERE matrix_id = $1 AND style_id = $2`,
    [matrixId, styleId]
  );
  if ((owned.rowCount ?? 0) > 0) return Response.json({ error: "already_owned" }, { status: 409 });

  // Admin price override (site.style_prices, migrate-v69) beats the catalog.
  const override = await pool.query<{ price: number }>(
    `SELECT price FROM site.style_prices WHERE style_id = $1`, [styleId]
  );
  const price = override.rows[0]?.price ?? style.price;

  // Shown vs charged: style prices are admin-repriceable live
  // (site.style_prices beats the catalog), so the confirm step could show one
  // number and this debit take another.
  const guard = priceGuard((body as { expectedPrice?: unknown } | null)?.expectedPrice, price);
  if (!guard.ok) {
    return Response.json({ error: guard.error, price: guard.price }, { status: guard.status });
  }

  const debit = await debitCoins({
    matrixId, amount: price, sink: "style", ref: spendId, meta: { style_id: styleId },
  });
  if (!debit.ok) return Response.json({ error: "insufficient_coins" }, { status: 402 });
  if (debit.replay) return Response.json({ ok: true, balance: debit.balance });

  const ins = await pool.query(
    `INSERT INTO site.user_style_unlocks (matrix_id, style_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING style_id`,
    [matrixId, styleId]
  ).catch(() => ({ rowCount: 0 }));
  if ((ins.rowCount ?? 0) === 0) {
    await refundCoins({ matrixId, amount: price, ref: spendId, meta: { reason: "already_owned" } })
      .catch((e) => console.error("[spend/style] refund failed:", e));
    return Response.json({ error: "already_owned" }, { status: 409 });
  }

  return Response.json({ ok: true, balance: debit.balance });
}
