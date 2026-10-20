import pool from "@/lib/db";
import { getMatrixSession } from "./matrixSession";
import { homeserverFetch } from "./homeserverFetch";
import { staffMatrixIds } from "./staff";
import { getBadgeSnapshot } from "./badgeCache";
import { shapePresenceDirectory, supporterSets, type DirRow } from "./presenceDirectory";
import { statusToMatrix, isSelfStatus, type SelfStatus, type PresenceDirectory } from "./presenceState";

// Server half of presence. The rule itself is pure and lives in
// presenceState.ts; this file owns the queries and the Matrix mirror.

/** The caller's self-set status. Isolated + error-swallowing on purpose (the
 *  banner query in /api/me has the same shape): a prod that has not applied
 *  v120 yet must not turn every /api/me into nulls. */
export async function readPresenceStatus(matrixId: string): Promise<{ status: SelfStatus; statusText: string }> {
  const { rows } = await pool
    .query<{ status: string; status_text: string }>(`SELECT status, status_text FROM site.presence WHERE matrix_id = $1`, [matrixId])
    .catch(() => ({ rows: [] as { status: string; status_text: string }[] }));
  const r = rows[0];
  return { status: r && isSelfStatus(r.status) ? r.status : "online", statusText: r?.status_text ?? "" };
}

/** Mirror a self-set status to Matrix AS the user (their own session token),
 *  so Element shows the same thing. Best-effort: logged, never thrown, and the
 *  token never reaches a log line. */
export async function mirrorStatusToMatrix(status: SelfStatus, text: string): Promise<void> {
  try {
    const mx = await getMatrixSession();
    if (!mx) return;
    const res = await homeserverFetch(`${mx.homeserver}/_matrix/client/v3/presence/${encodeURIComponent(mx.matrixId)}/status`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${mx.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(statusToMatrix(status, text)),
    });
    // Only the status is used; release the connection (homeserverFetch's default deadline bounds
    // the request).
    void res.body?.cancel().catch(() => {});
    if (!res.ok) console.error("[presence] matrix mirror failed", res.status, status);
  } catch (e) {
    console.error("[presence] matrix mirror failed", status, e instanceof Error ? e.message : e);
  }
}

/** Every site account that has not been deleted, with its presence row (if any), as the caller
 *  `me` may see it — the disclosure rules (supporter only where the badge is worn, lastLogin only
 *  for the caller, invisible = the id alone) live in presenceDirectory.ts. `page` is never
 *  selected; the last-login subquery runs for the caller's own row only. */
export async function loadPresenceDirectory(me: string, nowDate: Date = new Date()): Promise<PresenceDirectory> {
  const { rows } = await pool.query<DirRow>(
    `SELECT u.matrix_id, p.last_beat, p.last_visible, p.last_community,
            COALESCE(p.status, 'online') AS status, COALESCE(p.status_text, '') AS status_text,
            CASE WHEN u.matrix_id = $1
              THEN (SELECT MAX(s.last_seen) FROM site.user_sessions s WHERE s.matrix_id = u.matrix_id)
            END AS last_login
     FROM site.users u
     LEFT JOIN site.presence p ON p.matrix_id = u.matrix_id
     WHERE u.deleted_at IS NULL`,
    [me]
  );
  const { entitled, badgeShown } = supporterSets(await getBadgeSnapshot(), staffMatrixIds());
  return shapePresenceDirectory(rows, { me, now: nowDate.getTime(), entitled, badgeShown });
}
