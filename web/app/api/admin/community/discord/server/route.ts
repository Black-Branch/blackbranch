import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { linkServerResponse, unlinkServerResponse } from "@/app/lib/community/discordAdmin";
import { discordDeps } from "@/app/lib/community/discordAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/server {guildId} — link the community to a Discord server.
// DELETE — unlink it (the bridge's bot leaves the Discord server). ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return linkServerResponse(req, discordDeps(admin));
}

export async function DELETE(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return unlinkServerResponse(discordDeps(admin));
}
