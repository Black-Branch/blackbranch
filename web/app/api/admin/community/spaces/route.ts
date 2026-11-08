import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { createSpaceResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/spaces {name, parentId} — a new category. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return createSpaceResponse(req, communityDeps(admin));
}
