import { siteName } from "./siteName.ts";
import { normalizePlatform } from "./nativePlatform.ts";
// Single source of truth for the combined-chat platform set: display labels and
// outbound routing. Pure constants only (no server imports) so both client
// components and server modules can share it.
//
// NOTE: StreamView's video switcher uses its own short-code keys (sp/yt/tw) for
// the *video* platforms — that's a separate concern and intentionally not here.

export const PLATFORM_LABELS: Record<string, string> = {
  twitch: "Twitch",
  youtube: "YouTube",
  tiktok: "TikTok",
  discord: "Discord",
  kick: "Kick",
  streamplace: "Streamplace",
  native: siteName(),
  all: "all platforms",
};

// The short letters a platform wears in front of a name where room is tight — the terminal's
// chat column ("@t:" rather than "@twitch:"). One per platform id above that has its own users;
// site/native names carry no prefix. yt and sp match the video switcher's codes.
// @parked plugin API: a site plugin's console beside the chat reads or drives the chat through it
export const PLATFORM_SHORT: Record<string, string> = {
  twitch: "t",
  youtube: "yt",
  kick: "k",
  streamplace: "sp",
  tiktok: "tt",
  discord: "d",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[String(normalizePlatform(platform))] ?? platform;
}

// Platforms the site can route an outbound message to (reply or destination
// toggle). Everything else falls back to native site chat.
// @test-only sendDestination.test.ts enumerates routable destinations.
export const ROUTABLE_PLATFORMS = new Set(["twitch", "kick", "youtube", "streamplace"]);

export function isRoutablePlatform(platform: string): boolean {
  return ROUTABLE_PLATFORMS.has(platform);
}

// Platforms temporarily disabled as cross-post DESTINATIONS — still linkable and
// still rendered in combined chat, just not offered as a send target. Empty;
// kept as the kill switch for any platform whose send path breaks.
//
// NOT exported: canCrossPost below is the only reader, and flipping the switch
// means editing this line anyway. Comments in chat/send/route.ts name it while
// describing the path a disabled platform takes — prose, not a call site.
const CROSSPOST_DISABLED = new Set<string>();

// Can the user cross-post TO this platform right now? (routable + not disabled)
export function canCrossPost(platform: string): boolean {
  return isRoutablePlatform(platform) && !CROSSPOST_DISABLED.has(platform);
}

// Stable display order for the in-composer destination toggle. The actual cycle
// is built at runtime from the platforms the user has linked (intersected with
// canCrossPost) — see ChatInput. null = native site chat; "all" = fan out to
// every linked, cross-postable platform.
export const DEST_ORDER = ["twitch", "kick", "streamplace", "youtube"] as const;
