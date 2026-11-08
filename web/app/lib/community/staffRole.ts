// The site's Staff role (site.users.is_staff): Staff on the community ladder, below Admin and above
// Mod (spec 2026-10-23 §4.2). Given and taken on Admin Panel › Moderators; the reconciler applies it
// in the community. SERVER ONLY, pure over injected deps; app/api/admin/staff/route.ts wires them.
// The flag is independent of is_mod: someone who is both holds both, and the ladder gives the higher.
//
// Relative imports only: node --test loads this with no "@/" alias.

export type StaffQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type StaffDeps = {
  query: StaffQuery;
  /** Append to site.mod_log; best effort, never throws. */
  log: (action: "staff_granted" | "staff_revoked", target: string, by: string) => Promise<void>;
  /** Ask the host for a community reconciler run (requestReconcile). True when it was asked. */
  reconcile: () => Promise<boolean>;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const LIST_SQL = `
  SELECT u.matrix_id, u.display_name,
         (SELECT l.created_at FROM site.mod_log l
           WHERE l.target_id = u.matrix_id AND l.action = 'staff_granted'
           ORDER BY l.id DESC LIMIT 1) AS since
    FROM site.users u
   WHERE u.is_staff AND u.deleted_at IS NULL
   ORDER BY lower(COALESCE(u.display_name, u.matrix_id))`;

/** GET → { staff: [{ matrixId, displayName, since }] }. */
export async function staffListResponse(query: StaffQuery): Promise<Response> {
  try {
    const { rows } = await query(LIST_SQL, []);
    return reply({
      staff: rows.map((r) => ({
        matrixId: r.matrix_id as string,
        displayName: (r.display_name as string | null) ?? null,
        since: r.since ? new Date(r.since as string | Date).toISOString() : null,
      })),
    });
  } catch {
    return reply({ error: "The Staff list could not be read. Try again." }, 503);
  }
}

/** Set or clear is_staff on a live account; `was` is the flag before the write, no row = no such account. */
const SET_SQL = `
  UPDATE site.users u SET is_staff = $1
    FROM (SELECT matrix_id, is_staff AS was FROM site.users
           WHERE matrix_id = $2 AND deleted_at IS NULL FOR UPDATE) prev
   WHERE u.matrix_id = prev.matrix_id
   RETURNING prev.was`;

/** POST { targetId, grant } → { ok, changed, requested }. The database first, then the log, then the
 *  host. The host is asked even when nothing changed: pressing again is how a change the host
 *  missed is sent again. */
export async function setStaffResponse(req: Request, admin: string, deps: StaffDeps): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { targetId?: unknown; grant?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return reply({ error: "Bad request." }, 400);
  const { targetId, grant } = b;
  if (typeof targetId !== "string" || !targetId || typeof grant !== "boolean") return reply({ error: "Bad request." }, 400);

  let rows: Record<string, unknown>[];
  try {
    rows = (await deps.query(SET_SQL, [grant, targetId])).rows;
  } catch {
    return reply({ error: "Not saved: the database did not answer. Try again." }, 503);
  }
  if (rows.length === 0) return reply({ error: "No account by that name." }, 404);
  const changed = !!rows[0]!.was !== grant;
  if (changed) await deps.log(grant ? "staff_granted" : "staff_revoked", targetId, admin);
  const requested = await deps.reconcile().catch(() => false);
  return reply({ ok: true, changed, requested });
}
