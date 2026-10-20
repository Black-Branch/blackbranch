import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { wantsIncome, query, NO_STORE } from "@/app/lib/streamTabServer";
import { loadSessionDetail } from "@/app/lib/streamStatsSql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/stream/sessions/<id>[?income=1] — one stream's review: its viewer curve, chat per
// 5 minutes and, with income=1, its
// money. Any session id of the stream resolves the whole logical stream. ADMIN ONLY. Read-only.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const id = decodeURIComponent((await params).id);
  if (!id || id.length > 64) return Response.json({ error: "bad stream id" }, { status: 400, headers: NO_STORE });
  const detail = await loadSessionDetail(query, id, wantsIncome(new URL(req.url)), Date.now());
  if (!detail) return Response.json({ error: "no such stream" }, { status: 404, headers: NO_STORE });
  return Response.json(detail, { headers: NO_STORE });
}
