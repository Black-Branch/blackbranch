import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { patchRoleResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/admin/community/roles/:key {label, colour, hoist} — a role's name and look. ADMIN ONLY, same-origin.
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return patchRoleResponse(req, (await params).key, communityDeps(admin));
}
