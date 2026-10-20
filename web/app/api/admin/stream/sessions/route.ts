import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { wantsIncome, query, NO_STORE } from "@/app/lib/streamTabServer";
import { loadSessions } from "@/app/lib/streamStatsSql";
import { isSessionSort, type SessionSummary } from "@/app/lib/streamStats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The list changes when a stream starts or ends, so a minute's cache is plenty: the picker opens
// once per visit, and the chat count is one scan of the whole chat log.
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; rows: SessionSummary[] }>();

// GET /api/admin/stream/sessions[?sort=date|viewers|duration|earned][&income=1] — the Stream tab's
// picker: the 100 newest logical streams, sorted.
// "earned" sorts by date unless income=1. ADMIN ONLY. Read-only.
export async function GET(req: Request) {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const url = new URL(req.url);
  const income = wantsIncome(url);
  const raw = url.searchParams.get("sort");
  const sort = isSessionSort(raw) && (raw !== "earned" || income) ? raw : "date";
  const key = `${sort}:${income ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json({ sessions: hit.rows, sort }, { headers: NO_STORE });
  const rows = await loadSessions(query, { income, sort, limit: 100 });
  cache.set(key, { at: Date.now(), rows });
  return Response.json({ sessions: rows, sort }, { headers: NO_STORE });
}
