import { type NextRequest } from "next/server";
import { requireAdminMutation, runInstanceTest } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/instance/<key>/test — one harmless, read-only provider call per process that
// holds the credential (web here; stream-api and stream-ingest through stream-api). ADMIN ONLY
// and SAME-ORIGIN ONLY (it spends a provider call), checked here. Results are fixed-shape codes
// rendered to fixed words — never a provider's text.
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { key } = await params;
  const r = await runInstanceTest(decodeURIComponent(key));
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
