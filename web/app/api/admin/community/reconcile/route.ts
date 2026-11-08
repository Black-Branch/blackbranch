import { requireAdminMutation } from "@/app/lib/instanceAdminServer";
import { reconcileResponse } from "@/app/lib/community/communityAdmin";
import { askMode, communityDeps } from "@/app/lib/community/communityAdminServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/community/reconcile {mode: "report"|"apply"} — ask the host for a run now. ADMIN ONLY, same-origin.
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return reconcileResponse(req, { ...communityDeps(admin), askMode });
}
