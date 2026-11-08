import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { deleteSpaceResponse, patchSpaceResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/community/spaces/:id — rename or move a category. ADMIN ONLY, same-origin.
export async function PATCH(req: Request, { params }: Ctx) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return patchSpaceResponse(req, (await params).id, communityDeps(admin));
}

// DELETE /api/admin/community/spaces/:id — an empty category. ADMIN ONLY, same-origin.
export async function DELETE(req: Request, { params }: Ctx) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return deleteSpaceResponse((await params).id, communityDeps(admin));
}
