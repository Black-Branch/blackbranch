import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { sanitizeChatMessage } from "@/app/lib/sanitize";
import { isSelfStatus } from "@/app/lib/presenceState";
import { mirrorStatusToMatrix } from "@/app/lib/presenceServer";

export const runtime = "nodejs";

// PUT /api/presence/status  { status, text } → { ok, status, statusText }
// The self-set status: Online / Idle / Do Not Disturb / Invisible +
// a custom line. Written here, then mirrored to Matrix as the user. Creating
// the row sets NO last_beat — a status is not a beat.
export async function PUT(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null);
  const status = body?.status;
  if (!isSelfStatus(status)) return new Response("Bad status", { status: 400 });
  const text = sanitizeChatMessage(String(body?.text ?? ""), 80);
  await pool.query(
    `INSERT INTO site.presence (matrix_id, status, status_text, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (matrix_id) DO UPDATE SET status = EXCLUDED.status, status_text = EXCLUDED.status_text, updated_at = now()`,
    [matrixId, status, text]
  );
  await mirrorStatusToMatrix(status, text);
  return Response.json({ ok: true, status, statusText: text });
}
