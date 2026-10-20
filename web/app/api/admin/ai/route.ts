import { requireAdminResponse, loadAiView } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/ai — the AI page's view: connections (key STATUS only), mode, default model,
// every slot and what it resolves to in each process, health, today's usage, the memory store.
// ADMIN ONLY, checked here (401 signed out / 403 not is_admin). No credential value is in this
// response or anywhere in its making (aiAdminView.ts).
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(await loadAiView(), { headers: { "Cache-Control": "no-store" } });
}
