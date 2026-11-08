// The admin role (site.users.is_admin): any admin makes or removes an admin, never the last one, and
// every change is a mod-log row (admin_granted / admin_revoked). Admin Panel › Moderators › Admins,
// and `sudo blackbranch user admin <name> on|off` on the server when nobody can sign in as an admin.
// A second admin is also how a lost admin account is recovered. SERVER ONLY, pure over injected
// deps; app/api/admin/admins/route.ts wires them. Relative imports only (node --test).

export type AdminQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type AdminDeps = {
  query: AdminQuery;
  /** Append to site.mod_log; best effort, never throws. */
  log: (action: "admin_granted" | "admin_revoked", target: string, by: string) => Promise<void>;
  /** Ask the host for a community reconciler run (requestReconcile): an admin's room power follows
   *  the role at once, not at the next timer run. True when it was asked. */
  reconcile: () => Promise<boolean>;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

const LIST_SQL = `
  SELECT u.matrix_id, u.display_name,
         (SELECT l.created_at FROM site.mod_log l
           WHERE l.target_id = u.matrix_id AND l.action = 'admin_granted'
           ORDER BY l.id DESC LIMIT 1) AS since
    FROM site.users u
   WHERE u.is_admin AND u.deleted_at IS NULL
   ORDER BY lower(COALESCE(u.display_name, u.matrix_id))`;

/**
 * Set or clear is_admin on a live account, refusing to clear the last admin. Every admin row and
 * the target are locked first, in one order: two admins removing each other at the same moment
 * serialise, and the second sees the first's commit (the lock re-reads the row) and is refused.
 * No row back = no such account, or the last admin (told apart by ADMIN_STATE_SQL).
 */
const SET_SQL = `
  WITH locked AS (
    SELECT matrix_id, is_admin FROM site.users
     WHERE (is_admin OR matrix_id = $2) AND deleted_at IS NULL
     ORDER BY matrix_id FOR UPDATE
  ), prev AS (
    SELECT is_admin AS was FROM locked WHERE matrix_id = $2
  )
  UPDATE site.users u SET is_admin = $1
    FROM prev
   WHERE u.matrix_id = $2
     AND ($1 OR NOT prev.was OR (SELECT count(*) FROM locked WHERE is_admin AND matrix_id <> $2) > 0)
   RETURNING prev.was`;

const ADMIN_STATE_SQL = "SELECT is_admin FROM site.users WHERE matrix_id = $1 AND deleted_at IS NULL";

const LAST_ADMIN = "That is the only admin. Make someone else an admin first.";

/** GET → { admins: [{ matrixId, displayName, since }] }. */
export async function adminListResponse(query: AdminQuery): Promise<Response> {
  try {
    const { rows } = await query(LIST_SQL, []);
    return reply({
      admins: rows.map((r) => ({
        matrixId: r.matrix_id as string,
        displayName: (r.display_name as string | null) ?? null,
        since: r.since ? new Date(r.since as string | Date).toISOString() : null,
      })),
    });
  } catch {
    return reply({ error: "The admin list could not be read. Try again." }, 503);
  }
}

/** POST { targetId, grant } → { ok, changed }; 409 for the last admin, 404 for no such account. */
export async function setAdminResponse(req: Request, admin: string, deps: AdminDeps): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { targetId?: unknown; grant?: unknown } | null;
  if (!b || typeof b !== "object" || Array.isArray(b)) return reply({ error: "Bad request." }, 400);
  const { targetId, grant } = b;
  if (typeof targetId !== "string" || !targetId || typeof grant !== "boolean") return reply({ error: "Bad request." }, 400);

  let rows: Record<string, unknown>[];
  try {
    rows = (await deps.query(SET_SQL, [grant, targetId])).rows;
    if (rows.length === 0) {
      const state = (await deps.query(ADMIN_STATE_SQL, [targetId])).rows[0];
      if (!state) return reply({ error: "No account by that name." }, 404);
      return reply({ error: LAST_ADMIN }, 409);
    }
  } catch {
    return reply({ error: "Not saved: the database did not answer. Try again." }, 503);
  }
  const changed = !!rows[0]!.was !== grant;
  if (changed) await deps.log(grant ? "admin_granted" : "admin_revoked", targetId, admin);
  // As for Staff: asked after every saved answer — pressing again re-sends a change the host missed.
  const requested = await deps.reconcile().catch(() => false);
  return reply({ ok: true, changed, requested });
}

/**
 * Inside the caller's transaction ("Delete my account"): clear this account's admin flag through the
 * SAME guarded, locking statement, so two admins deleting themselves at once can never leave none.
 * "last" = the only admin (the caller rolls back); "ok" otherwise (not an admin, or another admin
 * remains). The lock is held until the caller's transaction ends.
 */
export async function releaseAdminInTx(query: AdminQuery, matrixId: string): Promise<"ok" | "last"> {
  const { rows } = await query(SET_SQL, [false, matrixId]);
  if (rows.length > 0) return "ok";
  const state = (await query(ADMIN_STATE_SQL, [matrixId])).rows[0];
  return state?.is_admin === true ? "last" : "ok";
}

/** Is this account the site's only admin? ("Delete my account" refuses it: the site would be left
 *  with no admin and no way to get one.) */
export async function isLastAdmin(query: AdminQuery, matrixId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT u.is_admin AND NOT EXISTS (
       SELECT 1 FROM site.users o WHERE o.is_admin AND o.deleted_at IS NULL AND o.matrix_id <> u.matrix_id) AS last
       FROM site.users u WHERE u.matrix_id = $1`, [matrixId]);
  return rows[0]?.last === true;
}
