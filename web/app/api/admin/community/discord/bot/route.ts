import { requireAdminMutation, requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { botViewResponse, setTokenResponse } from "@/app/lib/community/discordImportAdmin";
import { discordImportDeps } from "@/app/lib/community/discordImportServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/community/discord/bot — the bot as last read, and the server the community came from. ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return botViewResponse(discordImportDeps(admin));
}

// POST {token} — hand the bot token to the server (into .env; the site keeps no copy). ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return setTokenResponse(req, discordImportDeps(admin));
}
