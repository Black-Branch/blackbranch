import pool from "@/lib/db";
import { requireAdmin } from "@/app/lib/admin";
import { styleById } from "@/app/lib/usernameStyles";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Username-style price overrides (migrate-v69). The catalog in
// usernameStyles.ts is the DEFAULT; a site.style_prices row overrides it.
// GET → { prices: { [styleId]: number } } (overrides only — client merges
// over the catalog) · PATCH (admin) { styleId, price } sets an override,
// { styleId, price: null } resets to the catalog default. Styles are always
// on sale — unlike badges there is no delist state.

export async function GET() {
  const { rows } = await pool.query<{ style_id: string; price: number }>(
    `SELECT style_id, price FROM site.style_prices`
  );
  const prices: Record<string, number> = {};
  for (const r of rows) prices[r.style_id] = r.price;
  return Response.json({ prices });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireAdmin())) return new Response("Forbidden", { status: 403 });

  const body = (await req.json().catch(() => null)) as
    { styleId?: unknown; price?: unknown } | null;
  const style = typeof body?.styleId === "string" ? styleById(body.styleId) : null;
  if (!style) return new Response("Bad style", { status: 400 });

  if (body?.price === null) {
    await pool.query(`DELETE FROM site.style_prices WHERE style_id = $1`, [style.id]);
    return Response.json({ ok: true, price: style.price });
  }
  const price = Math.round(Number(body?.price));
  if (!Number.isFinite(price) || price <= 0 || price > 1_000_000)
    return new Response("Bad price", { status: 400 });

  await pool.query(
    `INSERT INTO site.style_prices (style_id, price) VALUES ($1, $2)
     ON CONFLICT (style_id) DO UPDATE SET price = EXCLUDED.price, updated_at = now()`,
    [style.id, price]
  );
  return Response.json({ ok: true, price });
}
