import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { deleteRoomResponse, patchRoomResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/admin/community/rooms/:id — change a channel. ADMIN ONLY, same-origin.
export async function PATCH(req: Request, { params }: Ctx) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return patchRoomResponse(req, (await params).id, communityDeps(admin));
}

// DELETE /api/admin/community/rooms/:id {confirm} — delete a channel the server never made.
export async function DELETE(req: Request, { params }: Ctx) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return deleteRoomResponse(req, (await params).id, communityDeps(admin));
}
