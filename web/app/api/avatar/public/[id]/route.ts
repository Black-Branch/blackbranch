import { NextRequest } from "next/server";
import { publicAvatar, isPublicAvatarId, publicAvatarIdForRole } from "@/app/lib/publicAvatar";
import { MEDIA_SAFETY_HEADERS } from "@/app/lib/mediaHeaders";

// GET /api/avatar/public/<matrixId | bot | streamer> — the avatar of an ALLOWLISTED account,
// served to everyone including signed-out visitors.
//
// The sibling route /api/avatar/user/[id] fetches media with the VIEWER's own
// Matrix token, which is right for people (initials until you sign in) and wrong
// for the two accounts that are part of the furniture: the help desk's button
// and the broadcaster's picture would be a letter circle for every signed-out visitor.
//
// 404 rather than a letter fallback, deliberately — the opposite of the user
// route. These call sites already have their own fallbacks (the help desk's button
// falls back to the letter avatar, the MetaBar to the initials circle), and a route
// that answers 200 with a placeholder cannot be distinguished from one that is
// working. A 404 here is legible in the network tab the moment the token lapses.
//
// Cache-Control is PUBLIC — that is the whole point, and it is only safe
// because the allowlist means nothing user-specific can ever be served from
// here. Do not widen the allowlist without revisiting this header.

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const raw = decodeURIComponent(id ?? "");
  // A ROLE word ("bot", "streamer") names one of the same two allowlisted accounts, so client
  // code never carries an account id (the ids are instance settings).
  const matrixId = publicAvatarIdForRole(raw) ?? raw;
  if (!matrixId.startsWith("@") || !matrixId.includes(":")) {
    return new Response("Bad Request", { status: 400 });
  }
  // Checked here as well as inside publicAvatar so the refusal is a 404 rather
  // than an empty 200, and so the allowlist is visible at the boundary.
  if (!isPublicAvatarId(matrixId)) return new Response("Not Found", { status: 404 });

  const avatar = await publicAvatar(matrixId);
  if (!avatar) return new Response("Not Found", { status: 404 });

  return new Response(avatar.body, {
    headers: {
      "Content-Type": avatar.type,
      "Cache-Control": "public, max-age=3600",
      ...MEDIA_SAFETY_HEADERS,
    },
  });
}
