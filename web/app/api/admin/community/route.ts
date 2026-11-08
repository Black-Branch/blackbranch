import { requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { communityViewResponse } from "@/app/lib/community/communityAdmin";
import { communityViewDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/community — the Community page: spaces, channels, roles, the last runs. ADMIN ONLY.
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return communityViewResponse(communityViewDeps());
}
