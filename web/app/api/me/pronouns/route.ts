import { auth } from "@/auth";
import { requireUser } from "@/app/lib/authGuard";
import pool from "@/lib/db";
import { askPronounCommand, PRONOUN_USAGE } from "@/app/lib/pronounCommand";
import { NextRequest } from "next/server";
import { canonicalFromMatrixSql } from "@/app/lib/canonicalFromMatrix";

// User-declared pronouns. Held on the CANONICAL identity (stream.users) so the
// same value is shared with the chat commands and survives identity merges. The
// website reads stream.* directly; every WRITE goes through stream-api's one
// parser (askPronounCommand) as `!pronouns <value>`, so Edit profile, `/pronouns`
// and the chat commands cannot disagree about what a value means. NULL = unset
// (the bot defaults to they/them).

async function save(matrixId: string, value: string) {
  const r = await askPronounCommand({ text: `!pronouns ${value}`, matrixId });
  if (!r) return Response.json({ error: "Couldn't save your pronouns right now." }, { status: 502 });
  if (!r.matched || r.usage) return Response.json({ error: PRONOUN_USAGE }, { status: 422 });
  return Response.json({ ok: true, pronouns: r.pronouns ?? null });
}

// The signed-in person's own pronouns: a display read, so the ONE preferred canonical
// (canonicalFromMatrix.ts) — the same one stream-api's pronoun writer resolves to.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ pronouns: null });
  const { rows } = await pool
    .query<{ pronouns: string | null }>(
      `SELECT u.pronouns FROM stream.users u WHERE u.id = ${canonicalFromMatrixSql("$1")}`,
      [session.user.id]
    )
    .catch(() => ({ rows: [] as { pronouns: string | null }[] }));
  return Response.json({ pronouns: rows[0]?.pronouns ?? null });
}

// POST { command } — `/pronouns <anything>`: the parser reads it (she, she/her,
// any, clear …) and answers with the usage line when it cannot.
export async function POST(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null);
  const command = typeof body?.command === "string" ? body.command.trim().slice(0, 40) : "";
  return save(matrixId, command);
}

// PATCH { pronouns } — Edit profile's picker.
export async function PATCH(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const body = await req.json().catch(() => null);
  const pronouns = typeof body?.pronouns === "string" ? body.pronouns.trim().slice(0, 40) : "";
  if (!pronouns) return new Response("Bad Request", { status: 400 });
  return save(matrixId, pronouns);
}

export async function DELETE() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  return save(matrixId, "clear");
}
