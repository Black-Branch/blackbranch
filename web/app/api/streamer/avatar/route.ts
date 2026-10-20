import { publicAvatar, publicAvatarIdForRole } from "@/app/lib/publicAvatar";
import { MEDIA_SAFETY_HEADERS } from "@/app/lib/mediaHeaders";

// GET /api/streamer/avatar — the broadcaster's picture for the MetaBar, served to
// everyone including signed-out viewers.
//
// A THIN WRAPPER over lib/publicAvatar, which owns the profile lookup, mxc
// parsing, the per-account cache and the token handling for every public
// avatar (the bot's too).
//
// The route survives rather than folding into /api/avatar/public/[id] because
// its URL is baked into page.tsx's fallback chain
// (STREAMER_AVATAR_URL ?? ytAvatar ?? "/api/streamer/avatar") and there is no
// reason to make callers know the broadcaster's matrix id.
//
// Config: STREAMER_MEDIA_TOKEN (a long-lived MAS compatibility token — see
// lib/publicAvatar for why a user session will not do), and optionally
// STREAMER_MATRIX_ID / BROADCASTER_MATRIX_ID. Setting STREAMER_AVATAR_URL to a
// plain public image URL bypasses this route entirely.

export async function GET() {
  // The streamer's account — instance key streamer.matrixId (publicAvatar.ts).
  const broadcaster = publicAvatarIdForRole("streamer");
  if (!broadcaster) return new Response(null, { status: 404 });

  const avatar = await publicAvatar(broadcaster);
  // 404 keeps the MetaBar's initials circle (the streamer's initials), which is what it did before.
  if (!avatar) return new Response(null, { status: 404 });

  return new Response(avatar.body, {
    headers: {
      "Content-Type": avatar.type,
      "Cache-Control": "public, max-age=3600",
      ...MEDIA_SAFETY_HEADERS,
    },
  });
}
