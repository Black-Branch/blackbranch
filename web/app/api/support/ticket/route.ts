import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { sanitizeChatMessage } from "@/app/lib/sanitize";
import { matchesBlacklist } from "@/app/lib/blacklist";
import { clampTicket } from "@/app/lib/support/validate";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Shared across the two support write routes on purpose: filing things is a
// human-paced act, and one person hammering either route is the same abuse.
const isLimited = createSlidingWindowLimiter(60_000, 5);

// POST /api/support/ticket { kind: "bug"|"other", body, transcript? } → { ok, id }
// Escalated from the help desk's support panel (site.support_tickets, migrate-v92).
// User REPORTS are not tickets — they go to /api/support/report → site.reports.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isLimited(`support-write:${matrixId}`)) {
    return Response.json({ error: "throttled" }, { status: 429 });
  }

  const clamped = clampTicket(await req.json().catch(() => null));
  if (!clamped) return new Response("Bad Request", { status: 400 });
  const body = sanitizeChatMessage(clamped.body);
  if (!body) return new Response("Bad Request", { status: 400 });
  if (matchesBlacklist(body)) return Response.json({ error: "blocked" }, { status: 422 });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO site.support_tickets (matrix_id, kind, body, transcript)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [matrixId, clamped.kind, body, clamped.transcript ? JSON.stringify(clamped.transcript) : null]
  );
  return Response.json({ ok: true, id: rows[0]?.id });
}
