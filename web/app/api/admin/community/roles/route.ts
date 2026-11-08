import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { createRoleResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/roles {label, level} — a role between two built-in ones. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return createRoleResponse(req, communityDeps(admin));
}
