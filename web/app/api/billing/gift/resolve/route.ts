import { resolveRecipient, isGiftableRecipient } from "@/app/lib/giftServer";
import { requireUser } from "@/app/lib/authGuard";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// GET /api/billing/gift/resolve?u=<username> → { matrixId, displayName } | 404
// Lets the gift UI validate a recipient before opening checkout. Auth-gated to
// avoid exposing user existence to anonymous callers.
export async function GET(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const u = req.nextUrl.searchParams.get("u") ?? "";
  if (!u.trim()) return new Response("Missing username", { status: 400 });

  const recipient = await resolveRecipient(u);
  if (!recipient) return new Response("No such user", { status: 404 });
  if (recipient.matrixId === matrixId) {
    return new Response("That’s you", { status: 400 });
  }
  if (!isGiftableRecipient(recipient.matrixId)) {
    return new Response("Can’t gift that user", { status: 400 });
  }
  return Response.json({ matrixId: recipient.matrixId, displayName: recipient.displayName });
}
