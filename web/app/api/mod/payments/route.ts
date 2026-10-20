import pool from "@/lib/db";
import { requireAdmin } from "@/app/lib/admin";
import { NextRequest } from "next/server";
import { NATIVE_SQL } from "@/app/lib/nativePlatform";
import { receivedRow, problemRow, mergePayments, type SupportEventRow, type ProblemRow } from "@/app/lib/paymentHistory";

// GET /api/mod/payments?outcome=&source=&before=&limit=200 — admin-only Payment history: every
// payment RECEIVED (stream.support_events, any platform) and every failed
// payment, refund and dispute (site.payment_events), newest first.
//   outcome  received | a problem code (failed, refunded…) | omitted = both
//   source   site | a platform (twitch, kofi…) | omitted = all — problems are the site's own
//   before   ISO time: rows older than it (the "Show older" cursor)
// Admin-only: this route is the real gate — the panel being admin-only is defense-in-depth.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return new Response("Forbidden — admin only", { status: 403 });

  const sp = req.nextUrl.searchParams;
  const outcome = sp.get("outcome");
  const source = sp.get("source");
  const beforeRaw = sp.get("before");
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw).toISOString() : null;
  const limitParam = Number(sp.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 500) : 200;

  const wantReceived = !outcome || outcome === "received";
  const wantProblems = (!outcome || outcome !== "received") && (!source || source === "site");
  // The site's own platform is stored as the native id; "site" asks for it.
  const nativeOnly = source === "site";

  const [problems, received, totals] = await Promise.all([
    wantProblems
      ? pool.query<ProblemRow>(
        `SELECT pe.*, u.display_name
         FROM site.payment_events pe
         LEFT JOIN site.users u ON u.matrix_id = pe.matrix_id
         WHERE ($1::text IS NULL OR pe.outcome = $1) AND ($2::timestamptz IS NULL OR pe.occurred_at < $2)
         ORDER BY pe.occurred_at DESC LIMIT $3`,
        [outcome && outcome !== "received" ? outcome : null, before, limit]
      )
      : null,
    wantReceived
      ? pool.query<SupportEventRow>(
        `SELECT se.id, se.created_at, se.username, se.event_type, se.amount_usd, se.platform
         FROM stream.support_events se
         WHERE ($1::boolean IS FALSE OR se.platform IN ${NATIVE_SQL})
           AND ($2::text IS NULL OR se.platform = $2)
           AND ($3::timestamptz IS NULL OR se.created_at < $3)
         ORDER BY se.created_at DESC LIMIT $4`,
        [nativeOnly, source && !nativeOnly ? source : null, before, limit]
      )
      : null,
    // The last 30 days' received total, for the same source.
    wantReceived
      ? pool.query<{ n: string; usd: string | null }>(
        `SELECT count(*) AS n, sum(se.amount_usd) AS usd
         FROM stream.support_events se
         WHERE se.created_at > now() - interval '30 days'
           AND ($1::boolean IS FALSE OR se.platform IN ${NATIVE_SQL})
           AND ($2::text IS NULL OR se.platform = $2)`,
        [nativeOnly, source && !nativeOnly ? source : null]
      )
      : null,
  ]);

  const { rows, nextBefore } = mergePayments(
    (received?.rows ?? []).map(receivedRow),
    (problems?.rows ?? []).map(problemRow),
    limit,
    { received: (received?.rows.length ?? 0) >= limit, problems: (problems?.rows.length ?? 0) >= limit },
  );
  const t = totals?.rows[0];
  return Response.json({
    rows,
    nextBefore,
    last30: t ? { count: Number(t.n), cents: Math.round(Number(t.usd ?? 0) * 100) } : null,
  });
}
