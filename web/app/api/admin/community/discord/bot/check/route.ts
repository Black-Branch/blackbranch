import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { checkBotResponse } from "@/app/lib/community/discordImportAdmin";
import { discordImportDeps } from "@/app/lib/community/discordImportServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/bot/check — read the bot again through the bridge. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return checkBotResponse(discordImportDeps(admin));
}
