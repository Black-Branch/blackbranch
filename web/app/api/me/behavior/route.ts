import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { sanitizeLists, isLegacyCanonicalId, type BehaviorLists } from "@/app/lib/behaviorLists";
import { NextRequest } from "next/server";
import { publicIdFor } from "@/app/lib/publicIdServer";
import { NATIVE_PLATFORM, isNativePlatform } from "@/app/lib/nativePlatform";

// A hidden entry saved before chat lines carried public ids is keyed by a canonical id (12 hex),
// which no line carries any more. The STORED list is rewritten once, the first time it is read:
// each such entry becomes one entry per public id of that canonical's platforms (the canonical
// covered every platform when the viewer hid it), and the rewritten list is saved. A canonical can
// only be in the stored list from before this change: PUT refuses them (isLegacyCanonicalId), so a
// viewer cannot add a stranger's canonical and read their platforms back.
async function rewriteLegacy(matrixId: string, lists: BehaviorLists): Promise<BehaviorLists> {
  const legacy = lists.hidden.filter((h) => isLegacyCanonicalId(h.id));
  if (legacy.length === 0) return lists;
  const { rows } = await pool.query<{ canonical: string; platform: string }>(
    `SELECT DISTINCT canonical, lower(platform) AS platform FROM stream.links WHERE canonical = ANY($1::text[])`,
    [legacy.map((h) => h.id)],
  );
  const by = new Map<string, string[]>();
  for (const r of rows) {
    const id = publicIdFor(r.canonical, isNativePlatform(r.platform) ? NATIVE_PLATFORM : r.platform);
    if (id) by.set(r.canonical, [...(by.get(r.canonical) ?? []), id]);
  }
  const next = sanitizeLists({
    ...lists,
    hidden: lists.hidden.flatMap((h) => (isLegacyCanonicalId(h.id)
      ? (by.get(h.id) ?? []).map((id) => ({ id, name: h.name, matrixId: h.matrixId }))
      : [h])),
  });
  await pool.query(
    `UPDATE site.user_behavior SET hidden = $2::jsonb, updated_at = now() WHERE matrix_id = $1`,
    [matrixId, JSON.stringify(next.hidden)],
  );
  return next;
}

export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const { rows } = await pool.query(
    `SELECT hidden, words FROM site.user_behavior WHERE matrix_id = $1`,
    [matrixId],
  );
  const stored = sanitizeLists(rows[0] ?? {});
  const lists = await rewriteLegacy(matrixId, stored).catch(() => stored);
  return Response.json({ lists });
}

// The whole lists, replaced — a list editor always sends its full state, so
// there is no partial-merge path to get wrong.
export async function PUT(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Bad Request", { status: 400 });
  }
  // A canonical id is never accepted from the client (see rewriteLegacy), nor anything but the
  // three fields sanitizeLists keeps.
  const raw = body as { hidden?: unknown };
  const lists = sanitizeLists({
    ...body,
    hidden: Array.isArray(raw.hidden)
      ? raw.hidden.filter((h) => !(h && typeof h === "object" && typeof (h as { id?: unknown }).id === "string" && isLegacyCanonicalId((h as { id: string }).id)))
      : [],
  });
  await pool.query(
    `INSERT INTO site.user_behavior (matrix_id, hidden, words, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, now())
     ON CONFLICT (matrix_id)
     DO UPDATE SET hidden = EXCLUDED.hidden, words = EXCLUDED.words, updated_at = now()`,
    [matrixId, JSON.stringify(lists.hidden), JSON.stringify(lists.words)],
  );
  return Response.json({ lists });
}
