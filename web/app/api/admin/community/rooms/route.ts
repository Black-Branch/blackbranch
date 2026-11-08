import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { createRoomResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/rooms — a new channel. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return createRoomResponse(req, communityDeps(admin));
}
