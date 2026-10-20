import { requireMod, requireAdmin } from "@/app/lib/admin";
import { emoteAdminAction } from "@/app/api/emotes/route";
import { NextRequest } from "next/server";

// Mod-gated emote-manifest refresh — the `/emotes refresh|check` site commands.
//
// WHY A PROXY. `/api/emotes` POST is deliberately internal-only: a forced rebuild
// bypasses the shrink guard and can overwrite BOTH the manifest and its last-good
// fallback, so an open endpoint would let anyone nuke every emote on the site.
// This route adds the mod check and calls the operation IN-PROCESS.
//
// In-process rather than by fetching its own public URL: that hairpin goes out
// through the tunnel and back into this same server, so a tunnel blip would come
// back as a bare "Refresh failed" with the real error recorded nowhere. Whatever
// CAN still fail is logged.
//
// This is the only manual refresh path — without it, the 30-minute TTL would be
// the only way and adding an emote mid-stream would be impossible.
export async function POST(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const body = await req.json().catch(() => null);
  const action = String((body as { action?: string } | null)?.action ?? "refresh");
  const force = (body as { force?: boolean } | null)?.force === true;
  if (action !== "refresh" && action !== "check") {
    return new Response("action must be refresh or check", { status: 400 });
  }

  // `force` bypasses the shrink guard and can overwrite the manifest AND its
  // last-good fallback — the command spec scopes it admin-only, and client
  // scope is UX only, so the real gate has to be here.
  if (force && !(await requireAdmin())) {
    return Response.json({ error: "force is admin-only" }, { status: 403 });
  }

  try {
    const { status, body: result } = await emoteAdminAction({ check: action === "check", force });
    if (status === 429) {
      return Response.json({ error: "Just refreshed — try again in a few seconds" }, { status: 429 });
    }
    return Response.json(result, { status });
  } catch (e) {
    // The one place this failure is visible — the caller is a chat command with
    // room for one line, so the journal carries the real error.
    console.error("[mod/emotes]", action, "failed:", e);
    return Response.json(
      { error: `Refresh failed: ${e instanceof Error ? e.message : "unknown error"}` },
      { status: 502 }
    );
  }
}
