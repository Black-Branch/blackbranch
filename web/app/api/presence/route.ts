import { requireUser } from "@/app/lib/authGuard";
import { loadPresenceDirectory } from "@/app/lib/presenceServer";

export const runtime = "nodejs";

// GET /api/presence → { counts, users } — every site account's presence row as the caller may
// see it (supporter only where the badge is worn, last login only for the caller, invisible =
// the id alone — see presenceDirectory.ts). Polled every 30 s by the members list while it is
// open. Read-only.
//
// A directory query failure is NOT swallowed into an empty list here — an
// empty `users` map would read as "everyone is Inactive", collapsing the
// whole list on a DB blip. It propagates to a 500 instead; the poller
// (usePresence.ts) already keeps its last good answer on any failed fetch.
export async function GET() {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;
  try {
    return Response.json(await loadPresenceDirectory(matrixId));
  } catch (e) {
    console.error("[presence] directory failed", e instanceof Error ? e.message : e);
    return new Response("Directory unavailable", { status: 500 });
  }
}
