import { auth } from "@/auth";
import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { setMatrixColor } from "@/app/lib/matrixProfile";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { NextRequest } from "next/server";

// A name colour can be set from a script (the terminal's profile file, an on_send hook). The page's own
// saver sends at most one change every 5 s per tab (app/lib/ownColor.ts); the server holds any caller to 60
// a minute per account, PATCH and DELETE together — a person never meets it, a loop hammering the URL gets
// 429s.
const isRateLimited = createSlidingWindowLimiter(60_000, 60);

async function writeMatrixColor(matrixId: string, color: string | null) {
  try {
    const mx = await getMatrixSession();
    if (!mx) return;
    await setMatrixColor(mx.homeserver, matrixId, mx.accessToken, color);
  } catch (e) {
    console.error("[me/color] matrix profile write failed:", (e as Error).message);
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ color: null });
  const { rows } = await pool.query(
    `SELECT username_color FROM site.users WHERE matrix_id = $1`,
    [session.user.id]
  ).catch(() => ({ rows: [] as { username_color: string | null }[] }));
  return Response.json({ color: rows[0]?.username_color ?? null });
}

export async function PATCH(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isRateLimited(matrixId)) return new Response("Too Many Requests", { status: 429 });

  const body = await req.json().catch(() => null);
  const color = body?.color;
  const valid = typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
  if (!valid) return new Response("Bad Request", { status: 400 });

  await pool.query(
    `UPDATE site.users SET username_color = $1 WHERE matrix_id = $2`,
    [color, matrixId]
  );
  // Fire-and-forget — don't block the response on Matrix profile write.
  writeMatrixColor(matrixId, color);
  return Response.json({ ok: true });
}

export async function DELETE() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isRateLimited(matrixId)) return new Response("Too Many Requests", { status: 429 });

  await pool.query(
    `UPDATE site.users SET username_color = NULL WHERE matrix_id = $1`,
    [matrixId]
  );
  writeMatrixColor(matrixId, null);
  return Response.json({ ok: true });
}
