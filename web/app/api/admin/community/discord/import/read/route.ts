import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { readImportResponse } from "@/app/lib/community/discordImportAdmin";
import { discordImportDeps } from "@/app/lib/community/discordImportServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/discord/import/read {guildId} — read one Discord server for the import. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return readImportResponse(req, discordImportDeps(admin));
}
