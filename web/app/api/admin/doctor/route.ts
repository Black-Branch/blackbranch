import { requireAdminResponse, requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { doctorView, doctorRecheck } from "@/app/lib/doctor/doctorServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/doctor — the doctor page's list: every check, its verdict and
// its fix line, from the host's last facts and the site's facts gathered now. ADMIN ONLY.
// Read-only: the module Tests run without recording a result.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(await doctorView(), { headers: { "Cache-Control": "no-store" } });
}

// POST /api/admin/doctor — "Check again": the host is asked for fresh facts (verb `doctor`, which
// only reads), then the list is made again. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return Response.json(await doctorRecheck(), { headers: { "Cache-Control": "no-store" } });
}
