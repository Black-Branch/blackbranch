import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { resolveIdentities } from "@/lib/socialCredit";
import { publicIdFor } from "@/app/lib/publicIdServer";
import { NATIVE_PLATFORM, isNativePlatform } from "@/app/lib/nativePlatform";

// GET /api/me/public-ids → { ids: string[] } — the signed-in person's OWN public ids, one per
// platform identity they hold (every canonical their account covers × every platform that canonical
// has). Chat lines carry only per-platform public ids now, so this is how the chat tells "my
// message" (and refuses "hide yourself") on every platform. Theirs alone: it answers only for the
// session's own account.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const { canonicalIds } = await resolveIdentities({ matrixId }).catch(() => ({ canonicalIds: [] as string[] }));
  if (canonicalIds.length === 0) return Response.json({ ids: [] });
  const { rows } = await pool.query<{ canonical: string; platform: string }>(
    `SELECT DISTINCT canonical, lower(platform) AS platform FROM stream.links WHERE canonical = ANY($1::text[])`,
    [canonicalIds],
  ).catch(() => ({ rows: [] as { canonical: string; platform: string }[] }));
  const ids = new Set<string>();
  for (const r of rows) {
    const id = publicIdFor(r.canonical, isNativePlatform(r.platform) ? NATIVE_PLATFORM : r.platform);
    if (id) ids.add(id);
  }
  return Response.json({ ids: [...ids] }, { headers: { "Cache-Control": "private, no-store" } });
}
