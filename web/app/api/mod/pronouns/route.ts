import pool from "@/lib/db";
import { requireMod, assertCanModerate } from "@/app/lib/admin";
import { appendModLog } from "@/app/lib/modlog";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";
import { askPronounCommand } from "@/app/lib/pronounCommand";
import { NextRequest } from "next/server";

// A mod sets someone's pronouns — from their card (canonicalId or
// matrixId, so it works for platform-only chatters too) or `/pronouns @name
// she/her` (stream-api finds who chatted under the name this month: exactly one
// person, or a 409 that sends the mod to the card). Written through stream-api's
// one parser as source 'mod', which an alejo.io fill can never overwrite; logged.
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = (await req.json().catch(() => null)) as
    { canonicalId?: unknown; matrixId?: unknown; name?: unknown; value?: unknown } | null;
  const value = typeof body?.value === "string" ? body.value.trim().slice(0, 40) : "";
  if (!value) return Response.json({ error: "Pick he/him, she/her, they/them or clear." }, { status: 400 });

  let canonicalId: string | null =
    typeof body?.canonicalId === "string" && /^[0-9a-f]{12}$/.test(body.canonicalId) ? body.canonicalId : null;
  if (!canonicalId && typeof body?.matrixId === "string" && body.matrixId.startsWith("@")) {
    const { rows } = await pool.query<{ canonical: string | null }>(
      `SELECT ${canonicalFromMatrixSql("$1")} AS canonical`, [body.matrixId]);
    canonicalId = rows[0]?.canonical ?? null;
  }
  const name = !canonicalId && typeof body?.name === "string" ? body.name.trim().slice(0, 64) : "";
  if (!canonicalId && !name) return Response.json({ error: "Nobody by that name has chatted yet." }, { status: 404 });

  // A name is resolved by stream-api from who CHATTED under it this month —
  // stream.nameidx holds only a name's first-ever owner. Asked first WITHOUT a write, so the
  // ceiling below judges the person before anything is saved.
  if (!canonicalId) {
    const who = await askPronounCommand({ text: `!pronouns ${value}`, name, source: "mod", resolveOnly: true });
    if (!who) return Response.json({ error: "Couldn't save that right now." }, { status: 502 });
    if (who.ambiguous) {
      return Response.json({ error: "More than one person chatted under that name this month — set it from their card." }, { status: 409 });
    }
    if (who.notFound) return Response.json({ error: "Nobody chatted under that name in the last 30 days — set it from their card." }, { status: 404 });
    if (!who.matched || who.usage || !who.canonicalId) return Response.json({ error: "Pick he/him, she/her, they/them or clear." }, { status: 422 });
    canonicalId = who.canonicalId;
  }

  // Privilege ceiling: a mod never sets the owner's or another mod's pronouns (their own is fine).
  // Judged on the identity that is WRITTEN (and on the account too, when the card named one).
  for (const target of [canonicalId, typeof body?.matrixId === "string" && body.matrixId.startsWith("@") ? body.matrixId : null]) {
    if (!target) continue;
    const denied = await assertCanModerate(mod, target);
    if (denied) return denied;
  }

  const r = await askPronounCommand({ text: `!pronouns ${value}`, canonicalId, source: "mod" });
  if (!r) return Response.json({ error: "Couldn't save that right now." }, { status: 502 });
  if (!r.matched || r.usage || !r.canonicalId) return Response.json({ error: "Pick he/him, she/her, they/them or clear." }, { status: 422 });
  canonicalId = r.canonicalId;

  await appendModLog({ action: "pronouns_set", target: canonicalId, by: mod, reason: r.pronouns ?? "cleared" });
  return Response.json({ ok: true, canonicalId, pronouns: r.pronouns ?? null });
}
