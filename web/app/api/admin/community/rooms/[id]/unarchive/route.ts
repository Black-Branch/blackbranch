import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { archiveRoomResponse } from "@/app/lib/community/communityAdmin";
import { communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/rooms/:id/unarchive — bring an archived channel back. ADMIN ONLY, same-origin.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return archiveRoomResponse((await params).id, false, communityDeps(admin));
}
