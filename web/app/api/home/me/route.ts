import { NextRequest } from "next/server";
import pool from "@/lib/db";
import { requireUser } from "@/app/lib/authGuard";
import { createSignupProgress, parseStep } from "@/app/lib/signupProgress";

// The caller's sign-up progress. GET → { step } (null = never
// started); PUT { step } → { ok, step }. Signed-in only; the public Home body
// lives at /api/home.
export async function GET() {
  const who = await requireUser();
  if (typeof who !== "string") return who;
  const step = await createSignupProgress({ pool }).read(who);
  return Response.json({ step }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function PUT(req: NextRequest) {
  const who = await requireUser();
  if (typeof who !== "string") return who;
  const body = await req.json().catch(() => null) as { step?: unknown } | null;
  const step = parseStep(body?.step);
  if (step === null) return Response.json({ error: "bad step" }, { status: 400 });
  await createSignupProgress({ pool }).write(who, step);
  return Response.json({ ok: true, step });
}
