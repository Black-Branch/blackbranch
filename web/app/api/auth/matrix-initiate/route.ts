import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { safeFetch } from "@/app/lib/ssrf";
import { readBodyPrefix, readJsonCapped, ERROR_LOG_MAX_BYTES, OAUTH_REPLY_MAX_BYTES } from "@/app/lib/boundedBody";
import { initiateEndpointsProblem, signFedState, fedStateSecret, FED_STATE_COOKIE, FED_STATE_TTL_S } from "@/app/lib/federatedSignIn";
import { pkcePair, randomToken } from "@/app/lib/pkce";
import { federatedServerAllowed, normalizeServerName, FEDERATED_SIGNIN_REFUSED } from "@/app/lib/federatedSignInSwitch";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { authOrigin } from "@/app/lib/authOrigin";
import { installValue } from "@/app/lib/installValues";
import { siteName } from "@/app/lib/siteName";

// Same origin as the MAS pair; this flow dynamically registers its
// redirect_uris, so a localhost origin works in dev with no server config.
const REDIRECT_URI = `${authOrigin()}/api/auth/matrix-callback`;

// Unauthenticated POST that does a server-side dynamic client registration against
// an arbitrary token endpoint. Rate-limit per client IP so it can't be driven as a
// registration-spam / SSRF-probe amplifier — 10/min is generous for a real user
// linking an external Matrix account.
const isRateLimited = createSlidingWindowLimiter(60_000, 10);

function matrixScope(deviceId: string): string {
  return `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`;
}

export async function POST(req: NextRequest) {
  if (isRateLimited(ipKey(req))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "invalid_body" }, { status: 400 });
  const { homeserver, authorizationEndpoint, tokenEndpoint, registrationEndpoint, deviceId } = body;

  if (typeof homeserver !== "string" || !homeserver || !tokenEndpoint || !authorizationEndpoint) {
    return Response.json({ error: "missing_fields" }, { status: 400 });
  }
  // The server the visitor asked to sign in with (discover named it): checked against the sign-in
  // policy here, and signed into the state cookie so the callback can hold the account to it.
  const serverName = normalizeServerName(body.serverName);
  if (!serverName) return Response.json({ error: "missing_fields" }, { status: 400 });
  if (!federatedServerAllowed(serverName)) return Response.json({ error: FEDERATED_SIGNIN_REFUSED }, { status: 403 });
  if (!registrationEndpoint) {
    return Response.json({ error: "no_registration_endpoint" }, { status: 422 });
  }

  // Device ID is mandatory — a session without one cannot maintain a coherent
  // crypto identity (see deviceId.ts invariant).
  if (typeof deviceId !== "string" || !/^[a-zA-Z0-9_-]{10,64}$/.test(deviceId)) {
    return Response.json({ error: "invalid_device_id" }, { status: 400 });
  }
  const effectiveDeviceId = deviceId;

  // The endpoints come from the browser: https only, one origin (federatedSignIn.ts). The
  // authorize URL is where the sign-in page sends the browser next — a `javascript:` one ran
  // script on this origin.
  const problem = initiateEndpointsProblem({ authorizationEndpoint, tokenEndpoint, registrationEndpoint });
  if (problem) return Response.json({ error: "invalid_endpoints", detail: problem }, { status: 400 });
  // The state cookie is signed; without the secret it cannot be, and is never set unsigned.
  const secret = fedStateSecret();
  if (!secret) {
    console.error("[matrix-initiate] no AUTH_SECRET — federated sign-in refused (the state cookie cannot be signed)");
    return Response.json({ error: "unavailable" }, { status: 503 });
  }

  // Dynamic client registration (RFC 7591) — register this site as a public client
  let clientId: string;
  try {
    const reg = await safeFetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: siteName(),
        client_uri: installValue("site.origin"),
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        application_type: "web",
        token_endpoint_auth_method: "none",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!reg.ok) {
      const body = await readBodyPrefix(reg, ERROR_LOG_MAX_BYTES);
      console.error(`[matrix-initiate] registration failed: ${reg.status}`, body);
      throw new Error(`registration failed: ${reg.status} — ${body.slice(0, 200)}`);
    }
    const regData = (await readJsonCapped(reg, OAUTH_REPLY_MAX_BYTES)) as { client_id?: unknown } | null;
    if (typeof regData?.client_id !== "string") throw new Error("registration returned no client_id");
    clientId = regData.client_id;
  } catch (e) {
    return Response.json({ error: "registration_failed", detail: String(e) }, { status: 502 });
  }

  const { codeVerifier, codeChallenge } = pkcePair();
  const state = randomToken(16);

  // State cookie: HttpOnly, Secure, 5 minutes — and SIGNED with its issued-at, which the callback
  // verifies before it reads a field or makes a request.
  const cookieStore = await cookies();
  cookieStore.set(FED_STATE_COOKIE, signFedState({ state, codeVerifier, tokenEndpoint, homeserver, clientId, deviceId: effectiveDeviceId, serverName }, secret), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: FED_STATE_TTL_S,
    path: "/",
  });

  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", matrixScope(effectiveDeviceId));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return Response.json({ authorizationUrl: url.toString() });
}
