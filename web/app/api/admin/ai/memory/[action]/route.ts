import { type NextRequest } from "next/server";
import { requireAdminMutation, runMemoryAction } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/ai/memory/enable       { connection, model }           — Turn on memory (probe)
// POST /api/admin/ai/memory/start-fresh  { connection, model, confirm? } — change the embedder;
//      without the exact stored count as `confirm` it only answers that count
// POST /api/admin/ai/memory/resume                                       — probe, then resume
// ADMIN ONLY and SAME-ORIGIN ONLY, checked here. The actor is the admin's own Matrix id from the
// session, never from the body.
export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const { action } = await params;
  const body = ((await req.json().catch(() => null)) ?? {}) as { connection?: unknown; model?: unknown; confirm?: unknown };
  const r = await runMemoryAction(decodeURIComponent(action), body, admin);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
