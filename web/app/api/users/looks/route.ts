import pool from "@/lib/db";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import { ipKey } from "@/app/lib/rateLimit";
import { parseStyleIds, styleLookupLimited } from "@/app/lib/userStyleIds";

export const dynamic = "force-dynamic";

// GET /api/users/looks?ids=@a:hs,@b:hs → { [matrixId]: { s: equipped name style, p: pronouns } }
// for those of the ids that have either. The Community timeline reads it so names wear the same
// styles and pronoun marks as live chat, where both already render on every line. Answers only
// for the ids asked (at most 200, rate-limited per address); without ids, {} (userStyleIds.ts).
//
// Pronouns live on the CANONICAL (stream.users) — the same hop the chat history
// route makes (canonicalFromMatrixSql) — the style on site.users.
// Accepted risk: like /api/users/colors it answers for any guessed Matrix id, not
// only ids recently on screen; it returns only what chat already shows beside a site line, and it
// is rate-limited with no bulk read.
type Looks = Record<string, { s?: unknown; p?: string }>;

export async function GET(req: Request) {
  const ids = parseStyleIds(new URL(req.url).searchParams.get("ids"));
  if (ids.length === 0) return Response.json({});
  if (styleLookupLimited(ipKey(req))) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "10" } });
  const { rows } = await pool.query<{ matrix_id: string; username_style: unknown; pronouns: string | null }>(
    `SELECT u.matrix_id, u.username_style, pu.pronouns
       FROM site.users u
       LEFT JOIN stream.users pu ON pu.id = ${canonicalFromMatrixSql("u.matrix_id")}
      WHERE u.matrix_id = ANY($1::text[]) AND u.deleted_at IS NULL
        AND (u.username_style IS NOT NULL OR pu.pronouns IS NOT NULL)`,
    [ids]
  );
  const data: Looks = {};
  for (const r of rows) {
    const entry: { s?: unknown; p?: string } = {};
    if (r.username_style) entry.s = r.username_style;
    if (r.pronouns) entry.p = r.pronouns;
    if (entry.s !== undefined || entry.p !== undefined) data[r.matrix_id] = entry;
  }
  return Response.json(data);
}
