import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { linkRoomResponse, unlinkRoomResponse } from "@/app/lib/community/discordAdmin";
import { discordDeps } from "@/app/lib/community/discordAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/links {roomId, channelId} — link a room to a Discord channel.
// DELETE {roomId} — unlink it. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return linkRoomResponse(req, discordDeps(admin));
}

export async function DELETE(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return unlinkRoomResponse(req, discordDeps(admin));
}
