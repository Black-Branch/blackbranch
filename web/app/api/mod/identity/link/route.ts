import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { streamApiFetch } from "@/app/lib/streamApi";
import { NextRequest } from "next/server";
import { ERASED_CANONICAL } from "@/app/lib/erasedPerson";

// Manual identity linkage (mod tools): fold two chat identities (stream
// canonicals) into one person. The merge engine lives in stream-api
// (POST /identity/merge → mergeCanonicals): it repoints chat history, stats,
// links and combines the bot's impressions, then DELETES the losing identity —
// there is no unmerge. It is mod-level, so the safety rails are here:
// the preview names which side survives, and the POST re-checks the typed
// victim name server-side before proxying.
//
// The erased-person row (ERASED_CANONICAL — every deleted person's kept lines and payments point at
// it) is no one: it is never offered, previewed or merged. Merging it into a live identity would
// hand that person every deleted person's kept history; merging a person into it would erase them.

type IdentityRow = {
  id: string; name: string | null; nickname: string | null;
  activity: number; first_seen: string | null;
  platforms: string[] | null;
  impression: string | null; interactions: number | null;
};

const DETAIL = `
  SELECT u.id, u.name, u.nickname, COALESCE(us.activity, 0)::int AS activity, u.first_seen,
         (SELECT array_agg(DISTINCT l.platform) FROM stream.links l WHERE l.canonical = u.id) AS platforms,
         bi.impression, bi.interactions
    FROM stream.users u
    LEFT JOIN stream.user_stats us ON us.user_id = u.id
    LEFT JOIN stream.bot_impressions bi ON bi.user_id = u.id`;

function shape(r: IdentityRow) {
  return {
    userId: r.id, name: r.name, nickname: r.nickname,
    activity: Number(r.activity) || 0, firstSeen: r.first_seen,
    platforms: r.platforms ?? [],
    impression: r.impression, interactions: r.interactions ?? 0,
  };
}
type Shaped = ReturnType<typeof shape>;

// Mirror of mergeCanonicals' survivor pick (most activity, tiebreak oldest) so
// the preview/confirm name the same side the engine will keep. stream-api
// still decides for real — this is presentation, not authority.
function rankSurvivorFirst(targets: Shaped[]): Shaped[] {
  return [...targets].sort(
    (a, b) => (b.activity - a.activity)
      || ((Date.parse(a.firstSeen ?? "") || 0) - (Date.parse(b.firstSeen ?? "") || 0))
  );
}

export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const preview = String(req.nextUrl.searchParams.get("preview") ?? "").trim();
  if (preview) {
    const ids = [...new Set(preview.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length !== 2) return new Response("preview needs two ids", { status: 400 });
    if (ids.includes(ERASED_CANONICAL)) return new Response("a deleted person's record cannot be merged", { status: 400 });
    const { rows } = await pool.query<IdentityRow>(`${DETAIL} WHERE u.id = ANY($1)`, [ids]);
    const ranked = rankSurvivorFirst(rows.map(shape));
    const [survivor, victim] = ranked;
    if (rows.length !== 2 || !survivor || !victim) return new Response("unknown identity", { status: 404 });
    return Response.json({ targets: ranked, survivorId: survivor.userId, victimId: victim.userId });
  }

  const q = String(req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return Response.json({ candidates: [] });
  const { rows } = await pool.query<IdentityRow>(
    `${DETAIL}
      WHERE (u.name ILIKE $1 OR u.nickname ILIKE $1 OR us.name ILIKE $1) AND u.id <> $2
      ORDER BY COALESCE(us.activity, 0) DESC
      LIMIT 12`,
    [`%${q}%`, ERASED_CANONICAL]
  );
  return Response.json({ candidates: rows.map(shape) });
}

export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => null)) as
    { canonicalIds?: string[]; confirmName?: string } | null;
  const ids = [...new Set((body?.canonicalIds ?? []).map((s) => String(s).trim()).filter(Boolean))];
  const confirmName = String(body?.confirmName ?? "").trim();
  if (ids.length !== 2) return new Response("two canonicalIds required", { status: 400 });
  if (!confirmName) return new Response("confirmName required", { status: 400 });
  if (ids.includes(ERASED_CANONICAL)) return new Response("a deleted person's record cannot be merged", { status: 400 });

  const { rows } = await pool.query<IdentityRow>(`${DETAIL} WHERE u.id = ANY($1)`, [ids]);
  const ranked = rankSurvivorFirst(rows.map(shape));
  const [survivor, victim] = ranked;
  if (rows.length !== 2 || !survivor || !victim) return new Response("unknown identity", { status: 404 });

  // Same privilege ceiling as ban and purge: a non-admin mod cannot act on the
  // owner, by site account or by a linked platform identity — and a merge,
  // unlike a ban, cannot be undone. Either side of the merge counts.
  for (const id of ids) {
    const denied = await assertCanModerate(mod, id);
    if (denied) return denied;
  }

  // The typed name must match the LOSING identity (name or nickname) — the
  // client gates on this too, but an irreversible action gets re-checked here.
  const matches = [victim.name, victim.nickname]
    .filter((n): n is string => !!n)
    .some((n) => n.toLowerCase() === confirmName.toLowerCase());
  if (!matches) {
    return new Response("confirmName does not match the losing identity", { status: 400 });
  }

  const res = await streamApiFetch("/identity/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canonicalIds: ids }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return new Response(t || "Merge failed", { status: 502 });
  }
  const d = (await res.json().catch(() => ({}))) as { survivor?: string; merged?: number };
  console.log(`[mod/identity] ${mod} merged ${victim.userId} -> ${d.survivor ?? survivor.userId}`);
  return Response.json({ ok: true, survivor: d.survivor ?? survivor.userId, merged: d.merged ?? 1 });
}
