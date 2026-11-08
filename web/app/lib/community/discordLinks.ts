// What the Discord bridge has linked, as the host last read it from the bridge's own database
// (results/discord-bridge-links.json, written by `blackbranch` discord_links through
// install/ooye/links.js). Read strictly: a file that is missing, too large or in another shape is
// UNKNOWN (null), never "nothing linked": a press that writes on the strength of it refuses instead.
// Spec: docs/superpowers/plans/2026-10-23-community-management-discord.md task 2.4.

export type BridgeGuild = { guildId: string; spaceId: string | null; privacyLevel: number | null };
export type BridgeLink = { channelId: string; roomId: string; guildId: string; name: string };
export type BridgeLinks = { guilds: BridgeGuild[]; links: BridgeLink[] };

export const NO_LINKS: BridgeLinks = { guilds: [], links: [] };
const SNOWFLAKE = /^\d{17,20}$/;
const ROOM = /^![^\s]{1,255}$/;
/** Rows per list at most (the host file's own cap, hostRequests.ts, is sized for it). */
const MAX = 2000;

/** The host's file, checked field by field; null when it cannot be read as that. */
export function bridgeLinksFrom(j: unknown): BridgeLinks | null {
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.guilds) || !Array.isArray(o.links) || o.guilds.length > MAX || o.links.length > MAX) return null;
  const guilds: BridgeGuild[] = [];
  for (const g of o.guilds as unknown[]) {
    const r = (g ?? {}) as Record<string, unknown>;
    if (typeof r.guildId !== "string" || !SNOWFLAKE.test(r.guildId)) return null;
    if (r.spaceId !== null && !(typeof r.spaceId === "string" && ROOM.test(r.spaceId))) return null;
    guilds.push({ guildId: r.guildId, spaceId: r.spaceId, privacyLevel: typeof r.privacyLevel === "number" ? r.privacyLevel : null });
  }
  const links: BridgeLink[] = [];
  for (const l of o.links as unknown[]) {
    const r = (l ?? {}) as Record<string, unknown>;
    if (typeof r.channelId !== "string" || !SNOWFLAKE.test(r.channelId) || typeof r.roomId !== "string" || !ROOM.test(r.roomId)
      || typeof r.guildId !== "string" || !SNOWFLAKE.test(r.guildId)) return null;
    links.push({ channelId: r.channelId, roomId: r.roomId, guildId: r.guildId, name: typeof r.name === "string" ? r.name.slice(0, 100) : "" });
  }
  return { guilds, links };
}

/** The Discord server linked to the community's space, if one is. */
export function linkedGuildOf(links: BridgeLinks, hubRoomId: string | null): BridgeGuild | null {
  return hubRoomId ? links.guilds.find((g) => g.spaceId === hubRoomId) ?? null : null;
}
