import pool from "@/lib/db";
import { ipKey } from "@/app/lib/rateLimit";
import { parseStyleIds, styleLookupLimited } from "@/app/lib/userStyleIds";

export const dynamic = "force-dynamic";

// GET /api/users/colors?ids=@a:hs,@b:hs → { [matrixId]: colour } for those of the ids that have
// chosen a name colour. The community and forum views draw names with it (the Matrix profile has
// no colour field). Public — the colours already render in live chat — but it answers only for
// the ids asked (at most 200, rate-limited per address): a request without ids gets {}, never the
// list of every account (userStyleIds.ts).
// Accepted: it answers for ANY guessed Matrix id, not only ids seen recently
// in public chat. What it returns is what chat already draws beside that name, it is rate-limited,
// and it cannot be enumerated without the ids; limiting it to "recently seen" ids would need a
// shared record of what was on screen, which nothing keeps.
export async function GET(req: Request) {
  const ids = parseStyleIds(new URL(req.url).searchParams.get("ids"));
  if (ids.length === 0) return Response.json({});
  if (styleLookupLimited(ipKey(req))) return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "10" } });
  const { rows } = await pool.query<{ matrix_id: string; username_color: string }>(
    `SELECT matrix_id, username_color FROM site.users
      WHERE matrix_id = ANY($1::text[]) AND username_color IS NOT NULL AND deleted_at IS NULL`,
    [ids]
  );
  return Response.json(Object.fromEntries(rows.map((r) => [r.matrix_id, r.username_color])));
}
