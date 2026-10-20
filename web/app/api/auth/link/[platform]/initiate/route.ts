import { NextRequest } from "next/server";
import { requireUser } from "@/app/lib/authGuard";
import { cookies } from "next/headers";
import { isModUser } from "@/app/lib/admin";
import { getPlatformConfig, scopesFor } from "@/app/lib/platformOAuth";
import { viewerMayLink } from "@/app/lib/viewerLinks";
import { pkcePair, randomToken } from "@/app/lib/pkce";
import { authOrigin } from "@/app/lib/authOrigin";

// Derived, not hardcoded: in dev this is what sends the platform's OAuth round
// trip back to localhost instead of the live site. See authOrigin.ts.
const BASE_URL = authOrigin();

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const matrixId = await requireUser();
  if (typeof matrixId !== "string") return matrixId;

  const { platform } = await params;
  const config = viewerMayLink(platform) ? getPlatformConfig(platform) : null;
  if (!config) {
    return Response.json({ error: "unsupported_platform" }, { status: 404 });
  }

  // Mods get the moderation scopes; regular viewers see a lean consent screen.
  const scopes = scopesFor(platform, await isModUser()).join(" ");

  const { codeVerifier, codeChallenge } = pkcePair();
  const state = randomToken(16);

  const cookieStore = await cookies();
  cookieStore.set(
    "mx_link_state",
    // scopes ride along so the callback can record what was REQUESTED when the
    // provider doesn't echo the granted set back.
    JSON.stringify({ state, codeVerifier, matrixId, platform, scopes }),
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 300,
      path: "/api/auth/link",
    }
  );

  const url = new URL(config.authorizationUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", `${BASE_URL}/api/auth/link/${platform}/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  // YouTube requires access_type=offline to get a refresh token
  if (platform === "youtube") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }

  return Response.json({ authorizationUrl: url.toString() });
}
