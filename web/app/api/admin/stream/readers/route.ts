import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { NO_STORE } from "@/app/lib/streamTabServer";
import { readIngestHealth } from "@/app/lib/ingestHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/stream/readers → { reachable: true, health } | { reachable: false } — the Stream
// tab's chat-reader states, from stream-ingest's /health (contract 1; ingestHealth.ts). ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(await readIngestHealth(), { headers: NO_STORE });
}
