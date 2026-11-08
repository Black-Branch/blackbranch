import pool from "@/lib/db";
import { requireAdminMutation, requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { appendModLog } from "@/app/lib/modlog";
import { requestReconcile } from "@/app/lib/community/reconcileRequest";
import { setStaffResponse, staffListResponse, type StaffQuery } from "@/app/lib/community/staffRole";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Staff role (site.users.is_staff), admin only: the Admin Panel's Staff list beside Moderators.
// Handlers: app/lib/community/staffRole.ts.
const query: StaffQuery = (sql, params) => pool.query(sql, params);

// GET → { staff: [{ matrixId, displayName, since }] }
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return staffListResponse(query);
}

// POST { targetId, grant } → { ok, changed, requested }
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return setStaffResponse(req, admin, {
    query,
    log: (action, target, by) => appendModLog({ action, target, by }),
    reconcile: () => requestReconcile(),
  });
}
