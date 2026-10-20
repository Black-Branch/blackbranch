import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { createBioServer } from "@/app/lib/bioServer";

// PATCH { bio } — the own card's one-line about (≤ 200 chars). PATCH like its
// siblings (/api/me/color, /api/me/pronouns) so ProfileEditor's saveProfileField
// serves it. Personal data: named in /legal "Account & profile"
// (legalClaims.test.ts).
export async function PATCH(req: NextRequest) {
  const who = await requireUser();
  if (typeof who !== "string") return who;
  const body = await req.json().catch(() => null) as { bio?: unknown } | null;
  const bio = await createBioServer({ pool }).setBio(who, body?.bio);
  return Response.json({ ok: true, bio });
}
