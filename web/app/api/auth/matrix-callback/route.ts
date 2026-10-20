import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import pool from "@/lib/db";
import { encToken } from "@/app/lib/tokenCrypto";
import { safeFetch } from "@/app/lib/ssrf";
import { checkSignupAllowed } from "@/app/lib/lockdown";
import { authOrigin } from "@/app/lib/authOrigin";
import { createIdentityResolver, RESOLVE_TIMEOUT_MS } from "@/app/lib/identityResolveServer";
import { streamApiFetch } from "@/app/lib/streamApi";
import { createSlidingWindowLimiter, ipKey } from "@/app/lib/rateLimit";
import { completeFederatedCallback, fedStateSecret, FED_STATE_COOKIE } from "@/app/lib/federatedSignIn";
import { accountDeletedForSignIn } from "@/app/lib/deletedAccounts";
import { federatedServerAllowed } from "@/app/lib/federatedSignInSwitch";
import { createLoginHandoff } from "@/app/lib/loginHandoff";

// Same origin as the MAS pair; this flow dynamically registers its
// redirect_uris, so a localhost origin works in dev with no server config.
// BASE_URL must read the same source — see authOrigin.ts for what a hardcoded
// one did to the final hand-off.
const REDIRECT_URI = `${authOrigin()}/api/auth/matrix-callback`;
const BASE_URL = authOrigin();

// The callback is unauthenticated and makes outbound requests to servers named in its cookie, so
// it is limited per client IP like matrix-initiate (10/min) — 20/min leaves room for a retry.
const isRateLimited = createSlidingWindowLimiter(60_000, 20);

const fail = (code: string) => NextResponse.redirect(new URL(`/auth/signin?error=${code}`, BASE_URL));

export async function GET(req: NextRequest) {
  if (isRateLimited(ipKey(req))) return fail("rate_limited");
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return fail("cancelled");
  if (!code || !stateParam) return fail("invalid_callback");

  // Every decision before the first write — the signed state cookie (verified before any field
  // is read or any request made), the code exchange, whoami, the device binding, the homeserver
  // that vouches for the MXID and the issuer that owns the token endpoint — is made here
  // (federatedSignIn.ts, tested with a stub transport).
  const cookieStore = await cookies();
  const cookie = cookieStore.get(FED_STATE_COOKIE)?.value;
  cookieStore.delete(FED_STATE_COOKIE);
  const outcome = await completeFederatedCallback(
    { code, state: stateParam, cookie },
    { fetch: (url, init) => safeFetch(url, init), secret: fedStateSecret(), now: () => Date.now(), redirectUri: REDIRECT_URI, log: console, serverAllowed: federatedServerAllowed },
  );
  if (!outcome.ok) return fail(outcome.error);
  const { matrixId, tokens } = outcome;

  // A deleted account is never signed in again — checked before the first write, so its
  // tombstone gets no session row, no tokens and no fresh OIDC metadata. No revoke: the
  // state does not record an outside server's revocation endpoint.
  const deleted = await accountDeletedForSignIn(matrixId).catch(() => null);
  if (deleted === null) return NextResponse.redirect(new URL("/auth/signin?error=unavailable", BASE_URL));
  if (deleted) {
    console.warn("[matrix-callback] refused sign-in to a deleted account");
    return NextResponse.redirect(new URL("/auth/deleted", BASE_URL));
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  const displayName = (matrixId.split(":")[0] ?? matrixId).replace(/^@/, "");

  // ── Raid panic switch ─────────────────────────────────────────────────────
  // The upsert below runs on EVERY login (it refreshes homeserver/OIDC
  // metadata), so this must gate "a new account" and not "the INSERT" —
  // otherwise throwing the switch would lock out every federated user who
  // already has an account. checkSignupAllowed makes that distinction.
  const gate = await checkSignupAllowed(matrixId);
  if (!gate.allowed) {
    console.warn(`[matrix-callback] signup refused (${gate.reason}) for ${matrixId}`);
    return NextResponse.redirect(new URL(`/auth/signin?error=${gate.reason}`, BASE_URL));
  }

  // Profile + OIDC metadata on site.users; token chains live in
  // site.user_sessions (one per device).
  // xmax = 0 on the returned row means this was an INSERT (new account), not an
  // UPDATE — so a first-time signup can claim a rollover gift slot.
  const upsert = await pool.query(
    `INSERT INTO site.users
       (matrix_id, display_name, homeserver, oidc_token_endpoint, oidc_client_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (matrix_id) DO UPDATE SET
       homeserver          = EXCLUDED.homeserver,
       oidc_token_endpoint = EXCLUDED.oidc_token_endpoint,
       oidc_client_id      = EXCLUDED.oidc_client_id
     RETURNING (xmax = 0) AS inserted`,
    [matrixId, displayName, outcome.homeserver, outcome.tokenEndpoint, outcome.clientId]
  );
  if (upsert.rows[0]?.inserted) {
    const { claimPendingGift } = await import("@/app/lib/giftServer");
    await claimPendingGift(matrixId).catch((e) => console.error("[gift] claim on signup failed", e));
  }

  // A site sign-in is the identity proof stream-api needs:
  // every sign-in, best-effort, never fails the sign-in.
  await createIdentityResolver({ pool, fetch: (p, i) => streamApiFetch(p, i, RESOLVE_TIMEOUT_MS) }).resolveSiteIdentity(matrixId).catch(() => {});

  // Non-empty by construction: the verified state requires one, and deviceMismatch checked it.
  const deviceId = outcome.deviceId;
  // A re-sign-in on the same device gets a NEW session id: the cookie from before it is dead
  // (siteSession.ts), not carried over with the device.
  const { rows: sessionRows } = await pool.query(
    `INSERT INTO site.user_sessions
       (matrix_id, mx_device_id, mx_access_token, mx_refresh_token, mx_token_expires)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (matrix_id, mx_device_id) DO UPDATE SET
       session_id       = gen_random_uuid(),
       mx_access_token  = EXCLUDED.mx_access_token,
       mx_refresh_token = EXCLUDED.mx_refresh_token,
       mx_token_expires = EXCLUDED.mx_token_expires,
       last_seen        = now(),
       signed_in_at     = now()
     RETURNING session_id`,
    [matrixId, deviceId, encToken(tokens.access_token), encToken(tokens.refresh_token ?? null), expiresAt]
  );

  // Create a short-lived one-time token for the Credentials provider to consume.
  // This hands off to Auth.js so it creates the session cookie through its own
  // mechanism — never manually encoding JWTs here. Bound to THIS browser by its cookie
  // (loginHandoff.ts): the link alone signs no other browser in.
  const handoff = await createLoginHandoff(matrixId, sessionRows[0].session_id);
  const pendingToken = handoff.token;
  cookieStore.set(handoff.cookie.name, handoff.cookie.value, handoff.cookie.options);

  return NextResponse.redirect(new URL(`/auth/federated-complete?token=${pendingToken}`, BASE_URL));
}
