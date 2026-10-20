// Pure halves of the personal Twitch emote system. DB/network live in
// userEmotesServer.ts; this module stays importable by tests and by
// platform-agnostic callers (mirrors the emoteManifestGuard split).

import type { EmoteMap } from "./emoteMap";

// The OAuth scope that unlocks Helix "Get User Emotes". platformOAuth.ts lists
// the same string literally in the twitch scopes array (deliberately NOT
// imported there, so the two can drift independently); the wiring test in
// personalEmotesWiring.test.ts pins the two against each other.
// @test-only the tests are the only consumer by design — see above.
export const EMOTE_SCOPE = "user:read:emotes";

export type HelixUserEmote = { id: string; name: string; format?: string[]; owner_id?: string };

// Same CDN shape as the manifest's twitchEmoteUrl (app/api/emotes/route.ts):
// dark/3.0 off the v2 template; Twitch emotes are square by spec, so ar: 1.
// `ch`: the owning channel's login via `ownerNames` (Helix Get Users, resolved
// by the server) — null for globals (owner_id "0"/absent), "" when the emote
// has an owner the lookup couldn't name (grouped as "Other channels" in the
// picker).
export function buildPersonalMap(
  list: HelixUserEmote[],
  ownerNames: Record<string, string>
): EmoteMap {
  const out: EmoteMap = {};
  for (const e of list) {
    if (!e?.id || !e?.name) continue;
    const fmt = e.format?.includes("animated") ? "animated" : "static";
    const owned = !!e.owner_id && e.owner_id !== "0";
    out[e.name] = {
      url: `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/${fmt}/dark/3.0`,
      zeroWidth: false,
      ar: 1,
      ch: owned ? (ownerNames[e.owner_id!] ?? "") : null,
    };
  }
  return out;
}

// Cache-format check: v1 rows (written before channel attribution) carry no
// `ch` key on their entries — treat them as expired so the next read
// re-fetches with owners instead of serving unlabelable data.
export function isPersonalCacheStale(map: Record<string, object>): boolean {
  return Object.values(map).some((e) => !("ch" in e));
}

// site.accounts.scope stores what was GRANTED, space-separated. Split, don't
// substring — "user:read:emotes:extra" must not count.
export function hasEmoteScope(scope: string | null | undefined): boolean {
  return typeof scope === "string" && scope.split(/\s+/).includes(EMOTE_SCOPE);
}
