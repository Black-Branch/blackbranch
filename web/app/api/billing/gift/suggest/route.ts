import { suggestRecipients } from "@/app/lib/giftServer";
import { requireUser } from "@/app/lib/authGuard";
import { NextRequest } from "next/server";

export const runtime = "nodejs";

// GET /api/billing/gift/suggest?q=<prefix> → { users: [{ username, displayName }] }
// Powers the gift-recipient autocomplete. Auth-gated so anonymous callers can't
// enumerate the user list; returns at most 8 giftable matches.
export async function GET(req: NextRequest) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const q = req.nextUrl.searchParams.get("q") ?? "";
  const users = await suggestRecipients(q, matrixId);
  return Response.json({ users });
}
