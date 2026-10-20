import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { pkcePair, randomToken } from "@/app/lib/pkce";
import { authOrigin } from "@/app/lib/authOrigin";
import { authMetadata } from "@/app/lib/matrixAuthMetadata";
import { matrixOAuthClientId, matrixServerName } from "@/app/lib/matrixConfig";

// The URI must be REGISTERED in MAS's client config — deriving it is
// necessary but not sufficient (localhost:3002 is the registered dev one).
// See authOrigin.ts.
const REDIRECT_URI = `${authOrigin()}/api/auth/mas-callback`;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const deviceId: unknown = body?.deviceId;

  if (!deviceId || typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{4,64}$/.test(deviceId)) {
    return Response.json({ error: "invalid_device_id" }, { status: 400 });
  }

  // The authorize endpoint is DISCOVERED (auth_metadata), never built onto the issuer. No
  // metadata = no sign-in, said plainly — a 503 the page shows, not a broken redirect.
  let authorizationEndpoint: string;
  try {
    authorizationEndpoint = (await authMetadata()).authorizationEndpoint;
  } catch {
    return Response.json({ error: "signin_unavailable" }, { status: 503 });
  }

  const { codeVerifier, codeChallenge } = pkcePair();
  const state = randomToken(16);

  const cookieStore = await cookies();
  cookieStore.set("mx_mas_state", JSON.stringify({ state, codeVerifier, deviceId }), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 300,
    path: "/",
  });

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", matrixOAuthClientId());
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`
  );
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // The setup pages sign the first admin in right after making the account: name it, so the
  // account server's sign-in page starts filled in. Only an id on this homeserver is passed on.
  const hint: unknown = body?.loginHint;
  if (typeof hint === "string" && /^@[a-z0-9._=/-]{1,64}:[a-z0-9.:-]+$/.test(hint) && hint.endsWith(`:${matrixServerName()}`)) {
    url.searchParams.set("login_hint", `mxid:${hint}`);
  }

  return Response.json({ authorizationUrl: url.toString() });
}
