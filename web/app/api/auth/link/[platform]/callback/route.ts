import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { getPlatformConfig } from "@/app/lib/platformOAuth";
import { viewerMayLink } from "@/app/lib/viewerLinks";
import { revokePlatformGrant } from "@/app/lib/platformRevoke";
import { encToken } from "@/app/lib/tokenCrypto";
import { streamApiFetch } from "@/app/lib/streamApi";
import { refreshPersonalEmotes } from "@/app/lib/userEmotesServer";
import pool from "@/lib/db";
import { authOrigin } from "@/app/lib/authOrigin";
import { claimPlatformAccount } from "@/app/lib/platformAccountLink";

// Derived, not hardcoded — see authOrigin.ts.
const BASE_URL = authOrigin();
// Land on "/" with the result params INTACT: UserMenu (mounted there) sees
// them and auto-opens the Linked accounts page, whose BannerReader renders the
// banner and strips them. The old /settings/accounts landing was a redirect
// stub that dropped the query string, so no banner could ever render
// (oauthBannerSurface.test.ts pins all three legs).
const SUCCESS_URL = `${BASE_URL}/`;

// `scopes` = what initiate actually REQUESTED (role-dependent — mods get the
// moderation scopes). Optional: older flows carry none.
type StateData = { state: string; codeVerifier: string; matrixId: string; platform: string; scopes?: string };

function errRedirect(platform: string, reason: string) {
  return NextResponse.redirect(new URL(`${SUCCESS_URL}?error=${reason}&platform=${platform}`, BASE_URL));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const stateParam = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return NextResponse.redirect(new URL(`${SUCCESS_URL}?error=cancelled&platform=${platform}`, BASE_URL));
  if (!code || !stateParam) return errRedirect(platform, "invalid_callback");

  const config = viewerMayLink(platform) ? getPlatformConfig(platform) : null;
  if (!config) return errRedirect(platform, "unsupported_platform");

  // Read and clear the state cookie
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get("mx_link_state")?.value;
  if (!rawCookie) return errRedirect(platform, "session_expired");

  let stateData: StateData;
  try {
    stateData = JSON.parse(rawCookie) as StateData;
  } catch {
    return errRedirect(platform, "invalid_state");
  }

  cookieStore.delete("mx_link_state");

  if (stateData.state !== stateParam || stateData.platform !== platform) {
    return errRedirect(platform, "state_mismatch");
  }

  // Verify the logged-in user matches who initiated the flow
  const session = await auth();
  if (!session?.user?.id || session.user.id !== stateData.matrixId) {
    return errRedirect(platform, "session_mismatch");
  }

  const matrixId = session.user.id;

  // Exchange code for tokens
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${BASE_URL}/api/auth/link/${platform}/callback`,
    code_verifier: stateData.codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
    signal: AbortSignal.timeout(10_000),
  });

  if (!tokenRes.ok) {
    console.error(`[link-callback:${platform}] token exchange:`, tokenRes.status, await tokenRes.text().catch(() => ""));
    return errRedirect(platform, "token_exchange_failed");
  }

  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    // Actually-granted scopes: Google returns a space-separated string, Twitch
    // an array. Absent on providers that don't echo scopes back.
    scope?: string | string[];
  };

  // Granular-consent guard: providers like Google let the user uncheck
  // individual scopes on the consent screen. If a scope the link can't work
  // without was declined, revoke the half-grant and bounce with a clear error
  // instead of storing a token that silently fails on every send.
  const grantedScopes = typeof tokens.scope === "string"
    ? tokens.scope.split(" ")
    : Array.isArray(tokens.scope) ? tokens.scope : null;
  if (config.requiredScopes && grantedScopes) {
    const missing = config.requiredScopes.filter(s => !grantedScopes.includes(s));
    if (missing.length > 0) {
      console.warn(`[link-callback:${platform}] required scope declined:`, missing.join(" "));
      await revokePlatformGrant(platform, { access: tokens.access_token, refresh: tokens.refresh_token });
      return errRedirect(platform, "permission_declined");
    }
  }

  // Fetch user info to get the platform ID and display name
  const userInfoRes = await fetch(config.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      ...config.userInfoHeaders,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!userInfoRes.ok) {
    console.error(`[link-callback:${platform}] user info:`, userInfoRes.status);
    return errRedirect(platform, "user_info_failed");
  }

  const userInfo = await userInfoRes.json();
  let platformUserId: string;
  let displayName: string;
  try {
    platformUserId = config.extractId(userInfo);
    displayName = config.extractDisplayName(userInfo);
    if (!platformUserId) throw new Error("empty id");
  } catch (e) {
    // A Google account with no YouTube channel is a user state, not a bug —
    // give it its own error param so the accounts page can say what to do.
    if (e instanceof Error && e.message === "NO_YOUTUBE_CHANNEL") {
      console.warn(`[link-callback:${platform}] account has no YouTube channel`);
      return errRedirect(platform, "no_youtube_channel");
    }
    // Don't log the raw provider payload — it can contain PII/tokens. Log only
    // the field names so a shape mismatch is still diagnosable.
    console.error(`[link-callback:${platform}] failed to extract user info; keys:`, Object.keys(userInfo ?? {}));
    return errRedirect(platform, "user_info_parse_failed");
  }

  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;

  // Ownership check and both writes, in one transaction under a per-account
  // lock: a platform account another site user holds is refused and nothing
  // changes — their stored tokens stay theirs (platformAccountLink.ts).
  const claim = await claimPlatformAccount(pool, {
    matrixId,
    platform,
    platformUserId,
    accessToken: encToken(tokens.access_token),
    refreshToken: encToken(tokens.refresh_token ?? null),
    expiresAt,
    // Record what was actually GRANTED (when the provider echoes it back),
    // not what we requested — with granular consent the two can differ.
    scope: grantedScopes?.join(" ") ?? stateData.scopes ?? config.scopes.join(" "),
    displayName,
  });
  if (!claim.linked) {
    console.warn(
      "[link] %s account %s is already linked to %s — refusing claim by %s",
      platform, platformUserId, claim.owner ?? "another account", matrixId
    );
    return errRedirect(platform, "already_linked");
  }
  const canonicalId = claim.canonicalId;

  // Personal Twitch emotes: warm the per-user set on link/re-link so the
  // picker has it on the next load. Best-effort — the 24h TTL read-through in
  // getPersonalEmotes covers a failure here.
  if (platform === "twitch") {
    void refreshPersonalEmotes(matrixId).catch((e) =>
      console.warn("[link] personal emote prefetch failed:", e)
    );
  }

  if (canonicalId) {
    // Unify identity: this account now links another platform, so fold all of
    // this person's canonicals (native + every linked platform) into one. Keeps
    // the bot's memory and the site profile coherent. Best-effort.
    streamApiFetch("/identity/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matrixId }),
    }).catch(() => {});
  }

  // `pending=1` = linked fine, but no stream canonical exists yet (they've
  // never chatted on this platform) — the accounts page explains the delay
  // instead of leaving "why didn't my stats connect?" a mystery.
  return NextResponse.redirect(
    new URL(`${SUCCESS_URL}?linked=${platform}${canonicalId ? "" : "&pending=1"}`, BASE_URL)
  );
}
