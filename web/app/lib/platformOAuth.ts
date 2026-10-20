import { instanceString } from "./instanceConfigServer.ts";
// Single source of truth for per-platform OAuth 2.0 configuration.
// getPlatformConfig() returns null if env vars are absent — the UI hides
// link buttons for unconfigured platforms; routes return 404.

export type PlatformConfig = {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  /** Scopes the link is useless without. Providers with granular consent
   *  (Google) let the user uncheck individual scopes on the consent screen;
   *  the callback rejects the link if any of these are missing from the
   *  actually-granted set, instead of storing a token that can't do its job. */
  requiredScopes?: string[];
  /** Moderation scopes — requested (and expected by missingScopes) only when
   *  the linking user is a mod/admin. Regular viewers keep the lean baseline
   *  `scopes` and never see a mod-permission consent screen. */
  modScopes?: string[];
  /** Extract the stable platform user ID from the user-info response. */
  extractId: (userInfo: unknown) => string;
  /** Extract the display name / login handle from the user-info response. */
  extractDisplayName: (userInfo: unknown) => string;
  /** Extra headers to include on user-info requests (e.g. Twitch's Client-Id). */
  userInfoHeaders?: Record<string, string>;
};

function build(): Record<string, PlatformConfig | null> {
  const configs: Record<string, PlatformConfig | null> = {};

  // --- Twitch ---
  const twitchId = instanceString("twitch.clientId");
  const twitchSecret = instanceString("twitch.clientSecret");
  configs.twitch = twitchId && twitchSecret ? {
    clientId: twitchId,
    clientSecret: twitchSecret,
    authorizationUrl: "https://id.twitch.tv/oauth2/authorize",
    tokenUrl: "https://id.twitch.tv/oauth2/token",
    userInfoUrl: "https://api.twitch.tv/helix/users",
    // user:read:emotes → Helix Get User Emotes (personal emote import)
    scopes: ["user:read:email", "chat:read", "user:write:chat", "user:read:emotes"],
    modScopes: [
      "moderator:manage:banned_users",
      "moderator:manage:chat_messages",
      "moderator:manage:chat_settings", // slow mode (mod suite)
      "moderator:manage:automod",       // automod-held queue (broadcaster link powers it)
    ],
    userInfoHeaders: { "Client-Id": twitchId! },
    extractId: (u) => {
      const item = (u as { data: { id: string }[] }).data[0];
      if (!item) throw new Error("twitch userinfo: empty data");
      return item.id;
    },
    extractDisplayName: (u) => {
      const item = (u as { data: { login: string }[] }).data[0];
      if (!item) throw new Error("twitch userinfo: empty data");
      return item.login;
    },
  } : null;

  // --- YouTube (Google OAuth) ---
  const ytId = instanceString("youtube.oauthClientId");
  const ytSecret = instanceString("youtube.oauthClientSecret");
  configs.youtube = ytId && ytSecret ? {
    clientId: ytId,
    clientSecret: ytSecret,
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    // Deliberately a SINGLE scope. liveChatMessages.insert accepts only
    // `youtube` or `youtube.force-ssl` (no chat-only scope exists), and the
    // identity fetch (channels?mine=true) works under `youtube` too — so
    // userinfo.profile and youtube.readonly would be pure consent-screen noise
    // (one "Manage your YouTube account" entry instead of three permission
    // blocks, and no access to name/gender/languages at all).
    scopes: ["https://www.googleapis.com/auth/youtube"],
    // Posting to live chat needs the full youtube scope — a link where the user
    // unchecked "Manage your YouTube account" would silently 403 on every send.
    requiredScopes: ["https://www.googleapis.com/auth/youtube"],
    // Empty `items` is a REAL user state, not a shape mismatch: a Google
    // account that never created a YouTube channel returns 200 with no items.
    // The sentinel lets the callback bounce with actionable copy ("create a
    // channel first") instead of the generic parse-failed error.
    extractId: (u) => {
      const item = (u as { items?: { id: string }[] }).items?.[0];
      if (!item) throw new Error("NO_YOUTUBE_CHANNEL");
      return item.id;
    },
    extractDisplayName: (u) => {
      const item = (u as { items?: { snippet: { title: string } }[] }).items?.[0];
      if (!item) throw new Error("NO_YOUTUBE_CHANNEL");
      return item.snippet.title;
    },
  } : null;

  // --- Kick (OAuth 2.1 — PKCE required) ---
  const kickId = instanceString("kick.clientId");
  const kickSecret = instanceString("kick.clientSecret");
  configs.kick = kickId && kickSecret ? {
    clientId: kickId,
    clientSecret: kickSecret,
    authorizationUrl: "https://id.kick.com/oauth/authorize",
    tokenUrl: "https://id.kick.com/oauth/token",
    userInfoUrl: "https://api.kick.com/public/v1/users",
    // `channel:moderate` does NOT exist in Kick's scope list (links made with
    // it got a token anyway, minus the phantom scope) — the real moderation
    // scopes are the two in modScopes (verified against docs.kick.com).
    // `channel:read` is documented but Kick NEVER echoes it as granted, so
    // requesting it leaves missingScopes permanently non-empty — the "Update
    // permissions" CTA could never clear. Nothing uses it (viewer polling runs
    // on the app token), so it is not requested.
    scopes: ["user:read", "chat:write"],
    modScopes: ["moderation:ban", "moderation:chat_message:manage"],
    extractId: (u) => {
      const d = (u as { data: { user_id?: number } | { user_id?: number }[] }).data;
      const item = Array.isArray(d) ? d[0] : d;
      if (!item) throw new Error("kick userinfo: empty data");
      return String(item.user_id);
    },
    extractDisplayName: (u) => {
      const d = (u as { data: { username?: string; name?: string } | { username?: string; name?: string }[] }).data;
      const item = Array.isArray(d) ? d[0] : d;
      return item?.username ?? item?.name ?? "";
    },
  } : null;

  return configs;
}

// Build once at module load — env vars don't change at runtime.
const PLATFORM_CONFIGS = build();

const SUPPORTED_PLATFORMS = ["twitch", "youtube", "kick"] as const;
export type SupportedPlatform = typeof SUPPORTED_PLATFORMS[number];

export function getPlatformConfig(platform: string): PlatformConfig | null {
  return PLATFORM_CONFIGS[platform] ?? null;
}

/** Platforms that are actually configured (env vars present). */
export function getConfiguredPlatforms(): SupportedPlatform[] {
  return SUPPORTED_PLATFORMS.filter(p => PLATFORM_CONFIGS[p] !== null);
}

/** The scope set to request for a given user: baseline for everyone, plus the
 *  moderation scopes only for mods/admins (their tokens power the platformMod
 *  fan-out; a regular viewer's token is never used to moderate). */
export function scopesFor(platform: string, isMod: boolean): string[] {
  const config = PLATFORM_CONFIGS[platform];
  if (!config) return [];
  return isMod ? [...config.scopes, ...(config.modScopes ?? [])] : config.scopes;
}

/**
 * Scopes the CURRENT config wants for this user's role that the stored link's
 * granted-scope string lacks — non-empty means the link predates a scope
 * addition (or the user unchecked something) and an "Update permissions"
 * relink would upgrade it. Unknown platforms (streamplace/ATProto has no
 * scopes) → [].
 */
export function missingScopes(platform: string, granted: string | null, isMod: boolean): string[] {
  const have = new Set((granted ?? "").split(/[\s,]+/).filter(Boolean));
  return scopesFor(platform, isMod).filter(s => !have.has(s));
}
