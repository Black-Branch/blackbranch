import { type NextRequest } from "next/server";
import { requireAdminMutation, runAiCheck } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/ai/detect/<connection> — the models that connection serves (Detect), asked with
// the connection's own key by the process that holds it. ADMIN ONLY and SAME-ORIGIN ONLY,
// checked here. The answer is a code and model ids — never provider text, never a key.
export async function POST(req: NextRequest, { params }: { params: Promise<{ connection: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { connection } = await params;
  const r = await runAiCheck("detect", decodeURIComponent(connection));
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
