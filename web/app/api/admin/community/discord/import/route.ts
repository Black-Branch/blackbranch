import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { confirmImportResponse } from "@/app/lib/community/discordImportAdmin";
import { discordImportDeps } from "@/app/lib/community/discordImportServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/import {guildId, roleTiers, choices} — make the community as confirmed. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return confirmImportResponse(req, discordImportDeps(admin));
}
