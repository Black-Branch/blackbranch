import pool from "@/lib/db";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { setMatrixDisplayName } from "@/app/lib/matrixProfile";
import { NextRequest } from "next/server";
import { sanitizeDisplayName } from "@/app/lib/sanitize";

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export async function PATCH(req: NextRequest) {
  const mx = await getMatrixSession().catch(() => null);
  if (!mx) return new Response("Unauthorized", { status: 401 });
  const matrixId = mx.matrixId;

  const { rows } = await pool.query(
    `SELECT display_name_changed_at FROM site.users WHERE matrix_id = $1`,
    [matrixId]
  ).catch(() => ({ rows: [] as { display_name_changed_at: Date | null }[] }));

  const changedAt = rows[0]?.display_name_changed_at;
  if (changedAt) {
    const msLeft = COOLDOWN_MS - (Date.now() - new Date(changedAt).getTime());
    if (msLeft > 0) return Response.json({ error: "cooldown", msLeft }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const name = sanitizeDisplayName(typeof body?.displayName === "string" ? body.displayName : "");
  if (!name) return new Response("Invalid display name", { status: 400 });

  const ok = await setMatrixDisplayName(mx.homeserver, matrixId, mx.accessToken, name);
  if (!ok) return new Response("Matrix update failed", { status: 502 });

  await pool.query(
    `UPDATE site.users SET display_name = $1, display_name_changed_at = NOW() WHERE matrix_id = $2`,
    [name, matrixId]
  ).catch(() => {});

  return Response.json({ ok: true });
}
