import { instanceString } from "./instanceConfigServer.ts";
// Shared Twitch Helix constants. The home channel's broadcaster id and the app's
// OAuth client-id are needed by every Helix call — chat sends (platformChat.ts)
// and moderation (platformMod.ts) — so they live here rather than being redefined
// per file.

// The home channel's broadcaster id — instance key platform.twitch.broadcasterId (env
// TWITCH_BROADCASTER_ID, alias TWITCH_USER_ID, else the stored value). Fail-closed: null when
// unset rather than a hardcoded live channel — a misconfigured install must NOT silently fire
// mod/chat actions on the real channel. Callers bail when null. Read per call (never at module
// load: `next build` evaluates route modules).
export function twitchBroadcasterId(): string | null {
  return instanceString("platform.twitch.broadcasterId");
}

/** The Twitch app's client id — credential twitch.clientId (env TWITCH_OAUTH_CLIENT_ID, alias
 *  TWITCH_CLIENT_ID, else the stored credential); "" when unset. Read per call. */
export function twitchClientId(): string {
  return instanceString("twitch.clientId") ?? "";
}

// App access token (client_credentials) for the Helix calls that speak as the APP
// rather than as a user: the emote manifest (/api/emotes) and the homepage's
// title/viewer/follower fetch. Both used to mint their own from a SECOND pair,
// TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET — and that pair had gone invalid (Twitch
// answered `{"status":400,"message":"invalid client"}`). Both call sites swallow
// their errors by design, so the site served ZERO Twitch emotes and a blank Twitch
// viewer count with nothing logged anywhere. One pair, one cache, one thing to
// break. `twitchAppToken` returns null on any failure; callers already bail.
let appToken: { value: string; expiresAt: number } | null = null;

export async function twitchAppToken(): Promise<string | null> {
  if (appToken && Date.now() < appToken.expiresAt) return appToken.value;
  const clientId = instanceString("twitch.clientId");
  const clientSecret = instanceString("twitch.clientSecret");
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: { access_token: string; expires_in: number } = await res.json();
    // Refresh an hour early. App tokens last ~60 days, so this is a wide margin.
    appToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 3600) * 1000 };
    return appToken.value;
  } catch {
    return null;
  }
}
