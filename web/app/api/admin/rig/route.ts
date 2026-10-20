import { requireAdminResponse, requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { rigStatus, rigAction } from "@/app/lib/rig/rigAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/rig — the OBS page's rig panel: is a rig page connected (since when, its OBS page
// permission and scene), the scenes it reported, and the browser source's address WITH this site's
// key. ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return Response.json(await rigStatus(), { headers: { "Cache-Control": "no-store" } });
}

// POST /api/admin/rig — { action: "regenerate" } (a new key; connected pages are closed),
// { action: "scene", name } (switch OBS's scene through the rig page), { action: "test", what:
// "voice" | "sound" } (a made-up clip through the real path). ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await rigAction(body, admin);
  return Response.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
