import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { pageFromPath } from "@/app/lib/presenceState";
import { readPresenceStatus } from "@/app/lib/presenceServer";

export const runtime = "nodejs";

// POST /api/presence/beat  { page, community, visible } → { ok, status, statusText }
// One row per person. Timestamps only move forward; status/status_text
// belong to PUT /api/presence/status and are never touched here. ~2 req/min/tab.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null);
  // The client sends a coarse page already; re-deriving from "/<page>" keeps an
  // unknown value from landing in the table as-is.
  const page = pageFromPath(`/${String(body?.page ?? "")}`.replace(/^\/stream$/, "/"));
  const visible = body?.visible === true;
  const community = body?.community === true;
  await pool.query(
    `INSERT INTO site.presence (matrix_id, last_beat, last_visible, last_community, page, updated_at)
     VALUES ($1, now(), CASE WHEN $2 THEN now() END, CASE WHEN $3 THEN now() END, $4, now())
     ON CONFLICT (matrix_id) DO UPDATE SET
       last_beat      = now(),
       last_visible   = CASE WHEN $2 THEN now() ELSE site.presence.last_visible END,
       last_community = CASE WHEN $3 THEN now() ELSE site.presence.last_community END,
       page           = $4,
       updated_at     = now()`,
    [matrixId, visible, community, page]
  ).catch((e) => console.error("[presence] beat failed", e instanceof Error ? e.message : e));
  const stored = await readPresenceStatus(matrixId);
  return Response.json({ ok: true, ...stored });
}
