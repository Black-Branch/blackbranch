import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { createSlidingWindowLimiter } from "@/app/lib/rateLimit";
import { sanitizeChatMessage } from "@/app/lib/sanitize";
import { matchesBlacklist } from "@/app/lib/blacklist";
import { clampReport } from "@/app/lib/support/validate";
import { clampMessageReport, reportedAuthor } from "@/app/lib/reportTarget";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// Same window as /api/support/ticket — filing is filing.
const isLimited = createSlidingWindowLimiter(60_000, 5);

// POST /api/support/report { username, reason } → { ok } | 404 user_not_found/ambiguous
//   or { platform, messageId, reason } — a report from a chat message (its ⋯ menu, the user card):
//   the message's author is resolved here, a platform-only chatter by canonical id (v155).
//   → { ok } | 404 message_not_found | 400 self
//
// FIRST WRITER of site.reports (migrate-v12) — the table sat dormant with no
// reader or writer until this panel flow. The ModPanel Support tab is its
// first reader. `status` stays at its 'pending' default; resolution happens in
// /api/mod/support.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  if (isLimited(`support-write:${matrixId}`)) {
    return Response.json({ error: "throttled" }, { status: 429 });
  }

  const raw = await req.json().catch(() => null);
  const byMessage = clampMessageReport(raw);
  if (byMessage) {
    const reason = sanitizeChatMessage(byMessage.reason);
    if (!reason) return new Response("Bad Request", { status: 400 });
    if (matchesBlacklist(reason)) return Response.json({ error: "blocked" }, { status: 422 });
    const author = await reportedAuthor((sql, p) => pool.query(sql, p), byMessage.platform, byMessage.messageId);
    if (!author) return Response.json({ error: "message_not_found" }, { status: 404 });
    if (author.matrixId === matrixId) return Response.json({ error: "self" }, { status: 400 });
    await pool.query(
      `INSERT INTO site.reports (reported_id, reported_canonical_id, reporter_id, reason, message_platform, message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [author.matrixId, author.canonicalId, matrixId, reason, byMessage.platform, String(byMessage.messageId)]
    );
    return Response.json({ ok: true });
  }

  const clamped = clampReport(raw);
  if (!clamped) return new Response("Bad Request", { status: 400 });
  const reason = sanitizeChatMessage(clamped.reason);
  const username = sanitizeChatMessage(clamped.username);
  if (!reason || !username) return new Response("Bad Request", { status: 400 });
  if (matchesBlacklist(reason)) return Response.json({ error: "blocked" }, { status: 422 });

  // Resolve the reported person: display name first, matrix localpart second.
  // site.users has no username column — display_name is what chat shows for
  // native users, and the localpart covers people typing the @handle form.
  // The name feeds an ILIKE pattern — escape its wildcards, or a "report"
  // against "%" pattern-matches the whole user table.
  const bare = username.replace(/^@/, "");
  const likeSafe = bare.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { rows } = await pool.query<{ matrix_id: string }>(
    `SELECT matrix_id FROM site.users
     WHERE lower(display_name) = lower($1)
        OR matrix_id ILIKE '@' || $2 || ':%'
     LIMIT 2`,
    [bare, likeSafe]
  );
  if (rows.length === 0) return Response.json({ error: "user_not_found" }, { status: 404 });
  if (rows.length > 1) return Response.json({ error: "ambiguous" }, { status: 404 });

  await pool.query(
    `INSERT INTO site.reports (reported_id, reporter_id, reason) VALUES ($1, $2, $3)`,
    [rows[0]!.matrix_id, matrixId, reason]
  );
  return Response.json({ ok: true });
}
