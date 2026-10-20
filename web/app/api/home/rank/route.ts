import { NextRequest } from "next/server";
import { requireUser } from "@/app/lib/authGuard";
import { resolveIdentities } from "@/lib/socialCredit";
import { findRank } from "@/app/lib/boards";
import { faceIdOf, isWindowId } from "@/app/lib/boardFaces";
import pool from "@/lib/db";
import { publicIdFor } from "@/app/lib/publicIdServer";

// The caller's own place on one face × window: a lookup in the
// boards cache over every identity they own (their matrix id plus the public id of each
// platform identity they hold — the keys a board row carries, boards.ts publicKey) — no SQL
// per viewer beyond the identity read. Signed-in only;
// the public top fives ride GET /api/home. A JSON `null` body means unranked.
export async function GET(req: NextRequest) {
  const who = await requireUser();
  if (typeof who !== "string") return who;
  const face = faceIdOf(req.nextUrl.searchParams.get("face"));
  const window = req.nextUrl.searchParams.get("window");
  if (face === null || !isWindowId(window)) return Response.json({ error: "bad face or window" }, { status: 400 });
  const ids = await resolveIdentities({ matrixId: who });
  const { rows } = await pool.query<{ canonical: string; platform: string }>(
    `SELECT DISTINCT canonical, lower(platform) AS platform FROM stream.links WHERE canonical = ANY($1::text[])`,
    [ids.canonicalIds],
  ).catch(() => ({ rows: [] as { canonical: string; platform: string }[] }));
  const keys = [...ids.matrixIds, ...rows.map((r) => publicIdFor(r.canonical, r.platform)).filter((k): k is string => !!k)];
  const rank = await findRank(face, window, keys);
  return Response.json(rank, { headers: { "Cache-Control": "private, no-store" } });
}
