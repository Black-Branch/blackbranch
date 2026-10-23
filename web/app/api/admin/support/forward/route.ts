import { type NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireAdminMutation, requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { forwarding, forwardTickets } from "@/app/lib/ticketForward";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/admin/support/forward              — whether tickets can be forwarded, and which were.
// POST /api/admin/support/forward { ids | all } — forward these open tickets (or every open one),
//                                                skipping those already sent.
// ADMIN ONLY (a ticket carries a viewer's own words); POST is SAME-ORIGIN ONLY too. The sending
// is ticketForward.ts's, which says when this release cannot send.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(forwarding(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => null)) as { ids?: unknown; all?: unknown } | null;
  let ids: number[];
  if (body?.all === true) {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM site.support_tickets WHERE status = 'open' ORDER BY id`);
    ids = rows.map((r) => Number(r.id));
  } else if (Array.isArray(body?.ids) && body.ids.length > 0 && body.ids.length <= 100 && body.ids.every((x) => Number.isInteger(x) && x > 0)) {
    ids = body.ids as number[];
  } else {
    return Response.json({ error: "ids (a list of ticket numbers) or all: true" }, { status: 400 });
  }
  const r = await forwardTickets(ids);
  return Response.json(r, { status: r.ok ? 200 : 501, headers: { "Cache-Control": "no-store" } });
}
