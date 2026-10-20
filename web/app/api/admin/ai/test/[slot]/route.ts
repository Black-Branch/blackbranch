import { type NextRequest } from "next/server";
import { requireAdminMutation, runAiCheck } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/ai/test/<slot> — one tiny real request through that task's resolved route, in
// the process that runs it (Test). ADMIN ONLY and SAME-ORIGIN ONLY, checked here. The answer is
// a fixed code and the measured latency — never provider text.
export async function POST(req: NextRequest, { params }: { params: Promise<{ slot: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { slot } = await params;
  const r = await runAiCheck("test", decodeURIComponent(slot));
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
