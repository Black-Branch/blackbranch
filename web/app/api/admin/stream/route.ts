import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { streamLiveNow, wantsIncome, query, NO_STORE } from "@/app/lib/streamTabServer";
import { loadLiveDashboard, loadSessions } from "@/app/lib/streamStatsSql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/stream[?income=1] — the Stream tab's live view: live or not; while live the whole
// logical stream's viewer curve and the last 30 minutes of chat; offline the last stream's summary.
// Money only with income=1, so the tab shows no money unless asked. ADMIN ONLY — this
// route is the gate; the tab being admin-only is defense in depth. Read-only.
export async function GET(req: Request) {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const income = wantsIncome(new URL(req.url));
  const { live } = await streamLiveNow();
  const atMs = Date.now();
  if (live.live) {
    const dash = await loadLiveDashboard(query, live.streamId, atMs, income);
    return Response.json({ live, dash, last: null, atMs }, { headers: NO_STORE });
  }
  const last = (await loadSessions(query, { income, sort: "date", limit: 5 })).find((s) => s.endedMs !== null) ?? null;
  return Response.json({ live, dash: null, last, atMs }, { headers: NO_STORE });
}
