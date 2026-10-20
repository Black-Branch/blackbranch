import { requireUser } from "@/app/lib/authGuard";
import { getPersonalEmotes } from "@/app/lib/userEmotesServer";

export const dynamic = "force-dynamic";

// The signed-in user's own Twitch emotes (+ whether their link predates the
// user:read:emotes scope). Private per user — never edge-cached.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  const { emotes, needsRelink } = await getPersonalEmotes(matrixId);
  return Response.json({ emotes, needsRelink }, { headers: { "Cache-Control": "private, no-store" } });
}
