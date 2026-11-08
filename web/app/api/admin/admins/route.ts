import pool from "@/lib/db";
import { requireAdminMutation, requireAdminResponse } from "@/app/lib/instanceAdminServer";
import { appendModLog } from "@/app/lib/modlog";
import { adminListResponse, setAdminResponse, type AdminQuery } from "@/app/lib/adminRole";
import { requestReconcile } from "@/app/lib/community/reconcileRequest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The admin role (site.users.is_admin), admin only: Admin Panel › Moderators › Admins. Any admin,
// never the last one; every change a mod-log row. Handlers: app/lib/adminRole.ts.
const query: AdminQuery = (sql, params) => pool.query(sql, params);

// GET → { admins: [{ matrixId, displayName, since }] }
export async function GET() {
  const admin = await requireAdminResponse();
  if (admin instanceof Response) return admin;
  return adminListResponse(query);
}

// POST { targetId, grant } → { ok, changed } · 409 for the last admin · 404 for no such account
export async function POST(req: Request) {
  const admin = await requireAdminMutation(req);
  if (admin instanceof Response) return admin;
  return setAdminResponse(req, admin, {
    query,
    log: (action, target, by) => appendModLog({ action, target, by }),
    // An admin's power in the community rooms follows the role at once (staffRole.ts does the same).
    reconcile: () => requestReconcile(),
  });
}
