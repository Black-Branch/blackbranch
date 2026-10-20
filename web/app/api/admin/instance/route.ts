import { requireAdminResponse, loadInstanceView } from "@/app/lib/instanceAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/instance — the Credentials page's view: every instance key, where each
// process gets it from, `…abcd` for a credential, last tests, each process's loaded/stale
// state. ADMIN ONLY, checked here (401 signed out / 403 not is_admin). Status only — no
// credential value is in this response or anywhere in its making (instanceAdminView.ts).
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(await loadInstanceView(), { headers: { "Cache-Control": "no-store" } });
}
