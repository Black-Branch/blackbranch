import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { discordViewResponse } from "@/app/lib/community/discordAdmin";
import { discordDeps } from "@/app/lib/community/discordAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/community/discord — the Discord page: the bridge's state, the linked Discord server,
// every room with its channel and whether the bridge holds that link. ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return discordViewResponse(discordDeps(admin));
}
