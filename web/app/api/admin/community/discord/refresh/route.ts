import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { discordRefreshResponse } from "@/app/lib/community/discordAdmin";
import { discordDeps } from "@/app/lib/community/discordAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/refresh — ask the server to read the bridge's links again. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return discordRefreshResponse(discordDeps(admin));
}
