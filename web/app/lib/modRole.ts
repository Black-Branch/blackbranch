// The moderator role: who passes the mod gate, and the one write that grants or removes it.
// Pure over an injected query so node --test can run it; admin.ts and the routes hand it the pool.
//
// Relative imports only: node --test loads this with no "@/" alias.

export type RoleQuery = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;

/** The row the mod gate reads for the signed-in account: its role flags, and whether a ban or
 *  timeout is running on it now. */
export const MOD_GATE_SQL =
  `SELECT u.is_mod, u.is_admin,
          EXISTS (SELECT 1 FROM site.bans b
                  WHERE b.matrix_id = u.matrix_id AND (b.expires_at IS NULL OR b.expires_at > NOW())) AS banned
     FROM site.users u WHERE u.matrix_id = $1`;

export type ModGateRow = { is_mod?: boolean | null; is_admin?: boolean | null; banned?: boolean | null };

/**
 * A mod or an admin passes; a banned or timed-out MOD does not — otherwise they keep the mod panel
 * and can lift their own ban. An admin passes even while banned: admins are the owner's accounts,
 * and an owner who banned their own account must still be able to lift it.
 */
export function passesModGate(row: ModGateRow | undefined): boolean {
  if (!row) return false;
  if (row.is_admin) return true;
  return !!row.is_mod && !row.banned;
}

/** Grant or remove the mod role. "changed" when the role moved, "unchanged" when it already was
 *  that, "not_found" when there is no such account. */
export async function applyModRole(q: RoleQuery, targetId: string, grant: boolean): Promise<"changed" | "unchanged" | "not_found"> {
  const { rows } = await q(
    `UPDATE site.users u SET is_mod = $1
       FROM (SELECT matrix_id, is_mod AS was FROM site.users WHERE matrix_id = $2 FOR UPDATE) prev
      WHERE u.matrix_id = prev.matrix_id
      RETURNING prev.was`,
    [grant, targetId],
  );
  if (rows.length === 0) return "not_found";
  return !!rows[0]!.was === grant ? "unchanged" : "changed";
}

