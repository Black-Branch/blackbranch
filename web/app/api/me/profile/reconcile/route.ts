import pool from "@/lib/db";
import { getMatrixSession } from "@/app/lib/matrixSession";
import { getMatrixProfile } from "@/app/lib/matrixProfile";

// Matrix → site reconcile. Pulls the user's real Matrix profile (displayname,
// avatar) back into site.users so external changes (made in Element or a mobile
// client) are reflected on the site. Fired once when the user's Matrix client
// comes up; throttled so it's a cheap DB read most of the time.
// The username colour is NOT pulled: site.users is the colour the UI uses, and the
// site is the only writer of the Matrix copy (me/color, fire-and-forget). One failed
// write leaves that copy stale, and pulling it would overwrite a newer choice or
// revive a cleared colour.
const THROTTLE_MS = 60 * 60 * 1000; // 1h

type ProfileRow = {
  display_name: string | null;
  avatar_url: string | null;
  username_color: string | null;
  profile_synced_at: Date | null;
};

function payload(reconciled: boolean, row: { display_name?: string | null; avatar_url?: string | null; username_color?: string | null } | null | undefined) {
  return Response.json({
    ok: true,
    reconciled,
    displayName: row?.display_name ?? null,
    avatarUrl: row?.avatar_url ?? null,
    color: row?.username_color ?? null,
  });
}

export async function POST() {
  const mx = await getMatrixSession().catch(() => null);
  if (!mx) return new Response("Unauthorized", { status: 401 });
  const matrixId = mx.matrixId;

  const { rows } = await pool.query(
    `SELECT display_name, avatar_url, username_color, profile_synced_at
       FROM site.users WHERE matrix_id = $1`,
    [matrixId]
  ).catch(() => ({ rows: [] as ProfileRow[] }));
  const cur = rows[0];

  // Throttle: serve the cached site values without touching Matrix.
  const syncedAt = cur?.profile_synced_at;
  if (syncedAt && Date.now() - new Date(syncedAt).getTime() < THROTTLE_MS) {
    return payload(false, cur);
  }

  const prof = await getMatrixProfile(mx.homeserver, matrixId, mx.accessToken);

  // All-null almost certainly means the profile fetch failed (a real account
  // basically always has a displayname). Don't write or stamp profile_synced_at —
  // let the next client-ready trigger retry it.
  if (prof.displayName === null && prof.avatarMxc === null && prof.color === null) {
    return payload(false, cur);
  }

  // COALESCE keeps the existing site value when Matrix returns null for a field, so
  // a transient per-field miss never blanks good data. (Tradeoff: an avatar REMOVED
  // externally isn't cleared here — only changes/sets propagate.)
  // The rename cooldown must apply to renames made THROUGH MATRIX too.
  // /api/me/displayname enforces 7 days; if this route pulled a Matrix-side
  // rename in without touching display_name_changed_at, then — since the browser
  // holds its own Matrix access token — renaming in Element and calling reconcile
  // would be an unlimited rename channel, bounded only by the throttle above.
  //
  // Stamped only on a REAL rename: the value differs AND there was a previous
  // name. That second condition matters — without it, a new account's first-ever
  // profile sync (display_name still NULL) would start a 7-day cooldown before
  // they had ever chosen a name. `display_name` on the right-hand side is the
  // pre-UPDATE value, which is what makes the comparison work.
  const { rows: updated } = await pool.query(
    `UPDATE site.users
        SET display_name      = COALESCE($1, display_name),
            avatar_url        = COALESCE($2, avatar_url),
            display_name_changed_at = CASE
              WHEN $1 IS NOT NULL
               AND display_name IS NOT NULL
               AND $1 IS DISTINCT FROM display_name
              THEN NOW()
              ELSE display_name_changed_at
            END,
            profile_synced_at = NOW()
      WHERE matrix_id = $3
      RETURNING display_name, avatar_url, username_color`,
    [prof.displayName, prof.avatarMxc, matrixId]
  ).catch(() => ({ rows: [] as ProfileRow[] }));

  return payload(true, updated[0] ?? cur);
}
