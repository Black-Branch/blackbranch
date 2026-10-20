import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { streamLiveNow, NO_STORE } from "@/app/lib/streamTabServer";
import { platformRows } from "@/app/lib/streamPlatformsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/stream/platforms — the Stream tab's Platforms section: per platform, set up or
// not, its embed switch, its current
// title where a key the site holds can read it, and where to change it. Titles are cached on the
// server (2 min; YouTube 5 min). The embed switch is written through the Admin Panel's own writer,
// PUT /api/admin/instance/player.embedsOff — this route only reads. ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  const { ytVideoId } = await streamLiveNow();
  return Response.json({ platforms: await platformRows(ytVideoId) }, { headers: NO_STORE });
}
