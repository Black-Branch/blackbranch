import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import pool from "@/lib/db";
import { encToken, decToken } from "@/app/lib/tokenCrypto";
import { checkSignupAllowed } from "@/app/lib/lockdown";
import { authOrigin } from "@/app/lib/authOrigin";
import { createIdentityResolver, RESOLVE_TIMEOUT_MS } from "@/app/lib/identityResolveServer";
import { streamApiFetch } from "@/app/lib/streamApi";
import { deviceMismatch } from "@/app/lib/signinDevice";
import { matrixBaseUrl } from "@/app/lib/matrixConfig";
import { oauthTokenRequest, oauthRevoke } from "@/app/lib/matrixOAuthClient";
import { accountDeletedForSignIn } from "@/app/lib/deletedAccounts";
import { createLoginHandoff } from "@/app/lib/loginHandoff";

// REDIRECT_URI must also be REGISTERED in MAS's client config — deriving it
// is necessary but not sufficient (localhost:3002 is the registered dev one).
// BASE_URL reads the SAME source, so the round trip finishes on the origin it
// started from: the one-time token below exists only there. See authOrigin.ts.
const REDIRECT_URI = `${authOrigin()}/api/auth/mas-callback`;
const BASE_URL = authOrigin();

type StateData = { state: string; codeVerifier: string; deviceId: string };

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return NextResponse.redirect(new URL("/auth/signin?error=cancelled", BASE_URL));
  if (!code || !stateParam) return NextResponse.redirect(new URL("/auth/signin?error=invalid_callback", BASE_URL));

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get("mx_mas_state")?.value;
  if (!rawCookie) return NextResponse.redirect(new URL("/auth/signin?error=session_expired", BASE_URL));

  let stateData: StateData;
  try {
    stateData = JSON.parse(rawCookie) as StateData;
  } catch {
    return NextResponse.redirect(new URL("/auth/signin?error=invalid_state", BASE_URL));
  }

  if (stateData.state !== stateParam) return NextResponse.redirect(new URL("/auth/signin?error=state_mismatch", BASE_URL));

  cookieStore.delete("mx_mas_state");

  // Exchange code for tokens (confidential client — client_secret_basic) at the DISCOVERED
  // token endpoint (matrixOAuthClient.ts). No metadata = a clean, named refusal; nothing written.
  let tokenRes: Response;
  try {
    tokenRes = await oauthTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: stateData.codeVerifier,
    }));
  } catch (e) {
    console.error("[mas-callback] token exchange unavailable:", e instanceof Error ? e.message : String(e));
    return NextResponse.redirect(new URL("/auth/signin?error=signin_unavailable", BASE_URL));
  }

  if (!tokenRes.ok) {
    console.error("[mas-callback] token exchange:", tokenRes.status, await tokenRes.text().catch(() => ""));
    return NextResponse.redirect(new URL("/auth/signin?error=token_exchange_failed", BASE_URL));
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // OUR homeserver (matrix.baseUrl) — not the issuer's origin, which is a different host.
  const whoami = await fetch(`${matrixBaseUrl()}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).then(r => r.ok ? r.json() : null).catch(() => null);

  if (!whoami?.user_id) return NextResponse.redirect(new URL("/auth/signin?error=whoami_failed", BASE_URL));

  // The token must be bound to the device we asked for (signinDevice.ts) —
  // checked BEFORE anything is written, so a refusal leaves no row behind.
  const refusal = deviceMismatch(stateData.deviceId, whoami);
  if (refusal) {
    console.error("[mas-callback] REFUSED sign-in for %s: %s", whoami.user_id, refusal);
    // Best-effort: do not leave a live sign-in session for a device we will not use.
    await oauthRevoke(tokens.access_token, "access_token");
    return NextResponse.redirect(new URL("/auth/signin?error=device_mismatch", BASE_URL));
  }

  const matrixId: string = whoami.user_id;

  // A deleted account is never signed in again — checked before the first write, so its
  // tombstone gets no session row and no tokens. The tokens just issued are revoked: nothing
  // here will use them.
  const deleted = await accountDeletedForSignIn(matrixId).catch(() => null);
  if (deleted !== false) {
    await Promise.allSettled([
      oauthRevoke(tokens.access_token, "access_token"),
      ...(tokens.refresh_token ? [oauthRevoke(tokens.refresh_token, "refresh_token")] : []),
    ]);
    if (deleted === null) return NextResponse.redirect(new URL("/auth/signin?error=unavailable", BASE_URL));
    console.warn("[mas-callback] refused sign-in to a deleted account");
    return NextResponse.redirect(new URL("/auth/deleted", BASE_URL));
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  const displayName = (matrixId.split(":")[0] ?? matrixId).replace(/^@/, "");

  // ── Raid panic switch (v82) ───────────────────────────────────────────────
  // Refuses only the creation of a NEW account; an existing user signing in is
  // waved through by checkSignupAllowed. Placed before the INSERT rather than
  // after so a blocked signup leaves no row and claims no gift slot.
  const gate = await checkSignupAllowed(matrixId);
  if (!gate.allowed) {
    console.warn(`[mas-callback] signup refused (${gate.reason}) for ${matrixId}`);
    return NextResponse.redirect(new URL(`/auth/signin?error=${gate.reason}`, BASE_URL));
  }

  // Profile row only — token chains live in site.user_sessions (one per device).
  // RETURNING tells us if this was a brand-new account so a first-time signup can
  // claim a rollover gift slot.
  const created = await pool.query(
    `INSERT INTO site.users (matrix_id, display_name, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (matrix_id) DO NOTHING
     RETURNING matrix_id`,
    [matrixId, displayName]
  );
  if ((created.rowCount ?? 0) > 0) {
    const { claimPendingGift } = await import("@/app/lib/giftServer");
    await claimPendingGift(matrixId).catch((e) => console.error("[gift] claim on signup failed", e));
  }

  // A site sign-in is the identity proof stream-api needs:
  // every sign-in, best-effort, never fails the sign-in.
  await createIdentityResolver({ pool, fetch: (p, i) => streamApiFetch(p, i, RESOLVE_TIMEOUT_MS) }).resolveSiteIdentity(matrixId).catch(() => {});

  // Re-auth of the same device replaces its chain; revoke the old sign-in session
  // first so each device has exactly one live session (no MAS clutter).
  const { rows: prior } = await pool.query(
    `SELECT mx_refresh_token FROM site.user_sessions WHERE matrix_id = $1 AND mx_device_id = $2`,
    [matrixId, stateData.deviceId]
  ).catch(() => ({ rows: [] as { mx_refresh_token: string | null }[] }));
  const oldRefresh = decToken(prior[0]?.mx_refresh_token);
  if (oldRefresh && oldRefresh !== tokens.refresh_token) {
    await oauthRevoke(oldRefresh, "refresh_token");
  }

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
    [matrixId, stateData.deviceId, encToken(tokens.access_token), encToken(tokens.refresh_token ?? null), expiresAt]
  );

  // The one-time hand-off to Auth.js, bound to THIS browser by its cookie (loginHandoff.ts): the
  // link alone signs no other browser in.
  const handoff = await createLoginHandoff(matrixId, sessionRows[0].session_id);
  const pendingToken = handoff.token;
  cookieStore.set(handoff.cookie.name, handoff.cookie.value, handoff.cookie.options);

  return NextResponse.redirect(new URL(`/auth/federated-complete?token=${pendingToken}`, BASE_URL));
}
