import { requireMod } from "@/app/lib/admin";
import { targetPlatformId, capabilityFor } from "@/app/lib/platformMod/shared";
import { NextRequest } from "next/server";

// GET /api/mod/platform-availability?targetId=@user:example.org
// TRUE per-platform mod-action availability for a target, resolved BEFORE a mod
// acts (the propagation log only shows outcomes after the fact): is the target
// known on the platform (identity graph), and could this mod's action actually
// land there (own token scope, broadcaster fallback, or nobody). Read-only and
// token-decrypt-free — see shared.capabilityFor.
//
// Scopes mirror the acting modules exactly (platformMod/{twitch,kick,youtube}).
const PROBES: { platform: string; banScope: string; deleteScope: string; liveOnly?: boolean }[] = [
  { platform: "twitch", banScope: "moderator:manage:banned_users", deleteScope: "moderator:manage:chat_messages" },
  { platform: "kick", banScope: "moderation:ban", deleteScope: "moderation:chat_message:manage" },
  { platform: "youtube", banScope: "https://www.googleapis.com/auth/youtube", deleteScope: "https://www.googleapis.com/auth/youtube", liveOnly: true },
];

export async function GET(req: NextRequest) {
  const mod = await requireMod();
  if (mod instanceof Response) return mod;

  const targetId = req.nextUrl.searchParams.get("targetId");
  if (!targetId) return new Response("Bad Request", { status: 400 });

  const platforms = await Promise.all([
    ...PROBES.map(async (p) => {
      const [platformUserId, canBan, canDelete] = await Promise.all([
        targetPlatformId(targetId, p.platform).catch(() => null),
        capabilityFor(mod, p.platform, p.banScope).catch(() => null),
        capabilityFor(mod, p.platform, p.deleteScope).catch(() => null),
      ]);
      return {
        platform: p.platform,
        targetKnown: platformUserId != null,
        canBan,
        canDelete,
        ...(p.liveOnly ? { liveOnly: true } : {}),
      };
    }),
    // stream.place has no moderation API — reported honestly, same convention
    // as the propagation view's "unsupported" rows.
    (async () => ({
      platform: "streamplace",
      targetKnown: (await targetPlatformId(targetId, "streamplace").catch(() => null)) != null,
      canBan: null,
      canDelete: null,
      unsupported: true as const,
    }))(),
  ]);

  return Response.json({ platforms });
}
