import { requireMod } from "@/app/lib/admin";
import pool from "@/lib/db";
import { parsePublicId } from "@/app/lib/publicIdServer";
import { ERASED_CANONICAL } from "@/app/lib/erasedPerson";
import { NATIVE_SQL } from "@/app/lib/nativePlatform";

// POST /api/mod/identity/resolve { ids: string[] } → { ids: { [publicId]: { canonicalId, matrixId } } }
//
// Chat lines carry only per-platform public ids (owner decision 2026-10-17); the moderation tools
// act by canonical id and site account. A moderator's chat resolves the ids on screen through here
// — batched and cached per page (modIdentity.ts), so a control has its target before it is clicked.
// Moderators only. `matrixId` is the site account linked to the identity, if any (a moderator sees
// links). Ids that do not read back (forged, another install's, the erased-person row) are left out.
const MAX_IDS = 200;

export async function POST(req: Request) {
  const mod = await requireMod();
  if (typeof mod !== "string") return mod;
  const body = await req.json().catch(() => null) as { ids?: unknown } | null;
  const asked = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, MAX_IDS) : [];
  const parsed = new Map<string, string>();
  for (const id of new Set(asked)) {
    const p = parsePublicId(id);
    if (p && p.canonical !== ERASED_CANONICAL) parsed.set(id, p.canonical);
  }
  if (parsed.size === 0) return Response.json({ ids: {} });
  const canonicals = [...new Set(parsed.values())];
  const { rows } = await pool.query<{ canonical: string; matrix_id: string }>(
    `SELECT DISTINCT ON (canonical) canonical, matrix_id FROM (
       SELECT canonical, platform_id AS matrix_id FROM stream.links WHERE platform IN ${NATIVE_SQL} AND canonical = ANY($1::text[])
       UNION ALL
       SELECT canonical_id, matrix_id FROM site.platform_links WHERE canonical_id = ANY($1::text[])
     ) x ORDER BY canonical, matrix_id`,
    [canonicals],
  ).catch(() => ({ rows: [] as { canonical: string; matrix_id: string }[] }));
  const site = new Map(rows.map((r) => [r.canonical, r.matrix_id]));
  const out: Record<string, { canonicalId: string; matrixId: string | null }> = {};
  for (const [id, canonical] of parsed) out[id] = { canonicalId: canonical, matrixId: site.get(canonical) ?? null };
  return Response.json({ ids: out }, { headers: { "Cache-Control": "private, no-store" } });
}
