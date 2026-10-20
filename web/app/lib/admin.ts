import { auth } from "@/auth";
import pool from "@/lib/db";
import { checkModerationCeiling, type CeilingOptions } from "./modCeiling";
import { authRefusal } from "./siteSession";
import { MOD_GATE_SQL, passesModGate, type ModGateRow } from "./modRole";

// Privilege ceiling for destructive moderation (ban/timeout/purge/merge): only an admin
// may act on an admin or a moderator, whether targeted by matrix id or by a linked
// platform canonical. `actorId` is the signed-in mod (from requireMod). Returns 403 to
// refuse, 503 when the database cannot answer (it fails closed), else null.
export function assertCanModerate(actorId: string, target: string, opts?: CeilingOptions): Promise<Response | null> {
  return checkModerationCeiling(actorId, target, (sql, params) =>
    pool.query<{ matrix_id: string; is_admin?: boolean; is_mod?: boolean }>(sql, params), opts);
}

// Returns the signed-in admin's matrix id, or null if not signed in / not an
// admin. Used to gate badge create/assign writes.
export async function requireAdmin(): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { rows } = await pool
    .query(`SELECT is_admin FROM site.users WHERE matrix_id = $1`, [session.user.id])
    .catch(() => ({ rows: [] as { is_admin: boolean }[] }));
  return rows[0]?.is_admin ? session.user.id : null;
}

// Boolean form for server COMPONENTS (a page can't return a Response — it
// redirects instead). Routes keep using requireMod below. Same gate (modRole.ts).
export async function isModUser(): Promise<boolean> {
  const session = await auth();
  if (!session?.user?.id) return false;
  const { rows } = await pool
    .query<ModGateRow>(MOD_GATE_SQL, [session.user.id])
    .catch(() => ({ rows: [] as ModGateRow[] }));
  return passesModGate(rows[0]);
}

// Returns the signed-in mod/admin's matrix id, or a ready-to-return error
// Response (401/403) if not. A banned or timed-out mod is refused (modRole.ts).
export async function requireMod(): Promise<string | Response> {
  const session = await auth();
  if (!session?.user?.id) return authRefusal(session) ?? new Response("Unauthorized", { status: 401 });
  const { rows } = await pool
    .query<ModGateRow>(MOD_GATE_SQL, [session.user.id])
    .catch(() => ({ rows: [] as ModGateRow[] }));
  if (!passesModGate(rows[0])) return new Response("Forbidden", { status: 403 });
  return session.user.id;
}
