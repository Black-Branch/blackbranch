// Revoke a platform OAuth grant at the provider, so unlinking (or a rejected
// link) actually retracts the app's access instead of just deleting our copy of
// the tokens — the grant otherwise stays listed in the user's provider account
// (e.g. Google security settings) indefinitely. Best-effort: a failed revoke
// never blocks the unlink; the user can always revoke provider-side.

import { getPlatformConfig } from "./platformOAuth.ts";

export async function revokePlatformGrant(
  platform: string,
  tokens: { access?: string | null; refresh?: string | null }
): Promise<void> {
  try {
    switch (platform) {
      case "youtube": {
        // Google: revoking either token kills the whole grant; prefer the
        // refresh token (revokes even if the access token already expired).
        const token = tokens.refresh ?? tokens.access;
        if (!token) return;
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(8_000),
        });
        return;
      }
      case "twitch": {
        const clientId = getPlatformConfig("twitch")?.clientId;
        if (!clientId || !tokens.access) return;
        await fetch("https://id.twitch.tv/oauth2/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, token: tokens.access }),
          signal: AbortSignal.timeout(8_000),
        });
        return;
      }
      case "kick": {
        if (!tokens.access) return;
        const qs = new URLSearchParams({ token: tokens.access, token_hint_type: "access_token" });
        await fetch(`https://id.kick.com/oauth/revoke?${qs}`, {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
        });
        return;
      }
      // streamplace (ATProto DPoP) has no bearer grant to revoke — the session
      // row deletion in the unlink route is the retraction.
      default:
        return;
    }
  } catch (e) {
    console.warn(`[platformRevoke:${platform}] revoke failed (non-fatal):`, e);
  }
}
