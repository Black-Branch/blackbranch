// A banned or timed-out account cannot start direct messages through the site: the DM routes
// refuse it and the one place a DM room is made (matrixDm.ts) asks first. Members are not
// reachable by a site-banned person this way while the ban runs — the default, with no switch.

/** The refusal both DM routes answer a banned caller with. */
export const DM_BANNED = "You can't send direct messages while you're banned.";

/** The active-ban check the DM routes run for the caller (server side, with the pool). */
export const ACTIVE_BAN_SQL =
  `SELECT 1 FROM site.bans WHERE matrix_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`;

/** Is the signed-in viewer banned or timed out now? (Browser; /api/me/ban.) Unknown reads as not
 *  banned — the server routes are the gate; this only spares a DM room that could not be used. */
export async function viewerBanned(): Promise<boolean> {
  try {
    const res = await fetch("/api/me/ban", { cache: "no-store" });
    if (!res.ok) return false;
    const d = (await res.json()) as { banned?: unknown };
    return d.banned === true;
  } catch {
    return false;
  }
}
