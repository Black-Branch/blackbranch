// GET /api/community/mods. Two readers:
//  • the admin's client reconciles each channel's power list against the site's mod list
//    (useModPowerSync): modIds — from site.users, the role's source of truth (the mod log is only
//    its record) — and keepIds, the install's own accounts that hold room power for the install;
//  • every signed-in member's client draws the community with the server's ladder: the hub, the
//    accounts no list shows, the roles, and who sits on the Staff and Bot rungs (readCommunityLadder).
// The mod list stays admin-only: nobody else can act on it.
import { readCommunityLadder, type CommunityLadder, type FeedEnv } from "./desiredServer.ts";

type Queryable = { query: <R extends object>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

type Deps = {
  /** The signed-in account and whether it is an admin (requireAdmin), or null when signed out. */
  viewer: () => Promise<{ id: string; admin: boolean } | null>;
  db: Queryable;
  env: () => FeedEnv;
  keepIds: () => Iterable<string>;
  log?: Pick<Console, "error">;
};

const MODS_SQL = `SELECT matrix_id FROM site.users WHERE (is_mod OR is_admin) AND deleted_at IS NULL ORDER BY matrix_id`;
const NO_STORE = { "Cache-Control": "no-store" };

export async function communityModsResponse(deps: Deps): Promise<Response> {
  const viewer = await deps.viewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });

  let ladder: CommunityLadder | null = null;
  try {
    ladder = await readCommunityLadder(deps.db, deps.env());
  } catch (e) {
    (deps.log ?? console).error("[community] ladder read failed:", e instanceof Error ? e.message : e);
  }
  if (!viewer.admin) {
    return ladder
      ? Response.json(ladder, { headers: NO_STORE })
      : Response.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  // The admin's answer keeps its two fields whatever the ladder did: a failed ladder read must not
  // stop the mod sync that worked before it existed.
  const { rows } = await deps.db.query<{ matrix_id: string }>(MODS_SQL);
  return Response.json({ modIds: rows.map((r) => r.matrix_id), keepIds: [...deps.keepIds()], ...ladder }, { headers: NO_STORE });
}
