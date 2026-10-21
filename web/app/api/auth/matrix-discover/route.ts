import { NextRequest } from "next/server";
import { safeFetch } from "@/app/lib/ssrf";
import { readJsonCapped, MATRIX_JSON_MAX_BYTES } from "@/app/lib/boundedBody";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { discoverIssuer } from "@/app/lib/federatedSignIn";
import { federatedServerAllowed, normalizeServerName, FEDERATED_SIGNIN_REFUSED } from "@/app/lib/federatedSignInSwitch";

// Unauthenticated server-side fetcher of an arbitrary homeserver's well-known +
// OIDC discovery. Its distinguishable error codes make it a mild SSRF/reachability
// oracle, so rate-limit per client IP — 20/min is far above a real user linking an
// external Matrix account, but throttles automated LAN probing. (The deeper SSRF
// DNS-rebinding hardening in ssrf.ts is tracked separately.)
const isRateLimited = createSlidingWindowLimiter(60_000, 20);

export async function GET(req: NextRequest) {
  if (isRateLimited(ipKey(req))) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }
  const mxid = req.nextUrl.searchParams.get("mxid")?.trim();
  if (!mxid) return Response.json({ error: "missing_mxid" }, { status: 400 });

  const match = mxid.match(/^@[^:]+:(.+)$/);
  if (!match) return Response.json({ error: "invalid_mxid" }, { status: 400 });
  const serverName = normalizeServerName(match[1]);
  if (!serverName) return Response.json({ error: "invalid_mxid" }, { status: 400 });
  // The sign-in policy, on the server the visitor asked for — before anything is fetched from it.
  if (!federatedServerAllowed(serverName)) return Response.json({ error: FEDERATED_SIGNIN_REFUSED }, { status: 403 });

  // Step 1: fetch .well-known/matrix/client from the server name
  let wellKnown: Record<string, unknown>;
  try {
    const wk = await safeFetch(`https://${serverName}/.well-known/matrix/client`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!wk.ok) return Response.json({ error: "well_known_failed" }, { status: 502 });
    const json = await readJsonCapped(wk, MATRIX_JSON_MAX_BYTES);
    if (json === null || typeof json !== "object") throw new Error("unreadable_document");
    wellKnown = json as Record<string, unknown>;
  } catch {
    // safeFetch throws on private/unresolvable targets (SSRF guard) too
    return Response.json({ error: "well_known_unreachable" }, { status: 502 });
  }

  const hs = wellKnown["m.homeserver"] as { base_url?: string } | undefined;
  if (!hs?.base_url) return Response.json({ error: "no_homeserver_url" }, { status: 502 });
  const homeserver = hs.base_url.replace(/\/$/, "");

  // Steps 2–3: the homeserver's own auth_metadata (`/_matrix/client/v1/auth_metadata`), else the
  // older MSC2965 path — the issuer its .well-known names and that issuer's openid-configuration.
  // BOTH go through the same validator (federatedSignIn.ts discoverIssuer → parseAuthMetadata): no
  // issuer pin (an outside server names its own), but every endpoint must be https on that issuer's
  // origin. An unvalidated fallback would let a `javascript:` authorize endpoint become the URL the
  // sign-in page navigates to.
  const found = await discoverIssuer(homeserver, wellKnown, (url, init) => safeFetch(url, init));
  if (!found.ok) {
    const status = found.error === "no_oidc" ? 422 : 502;
    return Response.json({ error: found.error, ...(found.error === "no_oidc" ? { homeserver } : {}) }, { status });
  }
  const md = found.metadata;
  return Response.json({
    // Sent back to initiate, which checks it again and signs it into the state cookie.
    serverName,
    homeserver,
    issuer: md.issuer.replace(/\/$/, ""),
    authorizationEndpoint: md.authorizationEndpoint,
    tokenEndpoint: md.tokenEndpoint,
    registrationEndpoint: md.registrationEndpoint,
  }, { headers: { "Cache-Control": "no-store" } });
}
