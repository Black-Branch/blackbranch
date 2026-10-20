import { requireAdminResponse, requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { updatesView, updatesCheckNow, updatesApply, updatesLiveNow } from "@/app/lib/updates/updatesServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/updates — the Updates section: the release in use, the last feed
// read, the release on offer, an update in progress, the last result, and whether the stream is
// live. ADMIN ONLY. Reads only.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const view = await updatesView();
  // Whether the stream is live: the panel holds Apply back while it is (the POST refuses it too).
  if (view.bundle) view.live = await updatesLiveNow();
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/admin/updates { action: "check" } | { action: "apply", version } — drops the host
// request `update-check` or `update-v<version>`. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  const body = (await req.json().catch(() => null)) as { action?: unknown; version?: unknown } | null;
  const view = body?.action === "check" ? await updatesCheckNow()
    : body?.action === "apply" ? await updatesApply(body.version)
      : null;
  if (!view) return Response.json({ error: "action must be check or apply" }, { status: 400 });
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
}
