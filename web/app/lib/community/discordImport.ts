// Import a Discord server as the community (community plan, Slice 2 task 2.3; spec 2026-10-23 §4.8).
// Pure: the page recomputes a proposal as the streamer changes a role's rung, and the confirm route
// computes it again from the same read. The read itself is the host's (discordImportAdmin.ts): the
// bot token stays in the bridge's container (install/ooye/discord-read.js, decision 0144).
//
// The mapping rules are spike 0.3's (vault briefs/community-1023/spikes.md §0.3, ported from its
// dry run's reduce()):
//   • a role's effective view/send = base (@everyone | the role) → Administrator passes everything →
//     the channel's @everyone overwrite → the role's own overwrite;
//   • a sentence is "every role whose rung is at least L" (Admins are inside every sentence); it
//     matches when that set EQUALS the set Discord lets in. Among equal matches the least restrictive
//     wins, except a set of Admins alone, which reads "Invited people only";
//   • no match: the widest sentence that lets in nobody Discord keeps out (fail closed, never wider
//     than Discord), and the channel goes on needsChoice with its overwrites spelled out;
//   • an announcement channel posts Mods and above unless Discord explicitly lets a wider group post;
//   • forum, voice, stage and media channels stay on Discord and are listed as kept.
import type { PostRule, SeeRule } from "./desired.ts";
import { validateRoomInput } from "./desired.ts";
import { defaultKeepDays, POST_WORDS, SEE_WORDS } from "./communityWords.ts";

export type Tier = "admin" | "staff" | "mod" | "bot" | "supporter" | "member";
export type DiscordOverwrite = { id: string; type: 0 | 1; allow: string; deny: string };
export type DiscordChannel = { id: string; name: string; type: number; position: number; parentId: string | null; topic: string | null; overwrites: DiscordOverwrite[] };
export type DiscordRole = { id: string; name: string; position: number; permissions: string; managed: boolean; tags: Record<string, string | null> };
export type DiscordGuild = {
  id: string; name: string; premiumTier: number;
  categories: DiscordChannel[]; channels: DiscordChannel[]; roles: DiscordRole[];
  emoji: { static: number; animated: number };
  /** When the host read it. */
  readAt?: string;
};

export type ProposedRoom = {
  discordId: string; spaceDiscordId: string | null; name: string; kind: "text" | "announcement"; topic: string | null;
  see: SeeRule; post: PostRule;
  /** Both sentences say exactly what Discord does. */
  exact: boolean;
  note: string | null;
};
export type RoleMapping = {
  id: string; name: string; tier: Tier;
  /** What decided the rung: bot, administrator, name, booster, linked platform, manage permissions, mod permissions, none, @everyone. */
  signal: string;
  /** Where a Supporter comes from: booster, twitch, youtube, platform, patreon, ko-fi, named. */
  source: string | null;
  /** A Discord mod that can manage channels: offered "Mod or Staff?" instead of guessed. */
  ask: boolean;
};
export type Proposal = {
  guild: { id: string; name: string };
  spaces: { discordId: string; name: string }[];
  rooms: ProposedRoom[];
  roleMap: RoleMapping[];
  kept: { discordId: string; name: string; kind: string; spaceDiscordId: string | null; reason: string }[];
  needsChoice: { discordId: string; name: string; words: string[]; overwrites: string[] }[];
  emoji: { static: number; animated: number; limit: number; fits: boolean };
};
export type ImportRules = { roleTiers?: Record<string, Tier> };

export const TIERS: readonly Tier[] = ["admin", "staff", "mod", "bot", "supporter", "member"];
export const TIER_WORDS: Readonly<Record<Tier, string>> = { admin: "Admin", staff: "Staff", mod: "Mod", bot: "Bot", supporter: "Supporter", member: "Member" };
const LEVEL: Readonly<Record<Tier, number>> = { member: 0, supporter: 10, mod: 50, bot: 50, staff: 75, admin: 100 };

// ── reading the host's line ───────────────────────────────────────────────────────────────────────

const SNOWFLAKE = /^\d{17,20}$/;
const BITS = /^\d{1,30}$/;
const isSnow = (v: unknown): v is string => typeof v === "string" && SNOWFLAKE.test(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const MAX_ITEMS = 1000;

function channelFrom(v: unknown): DiscordChannel | null {
  const c = obj(v);
  if (!c || !isSnow(c.id) || !isStr(c.name, 100) || !isInt(c.type) || !isInt(c.position)) return null;
  if (!(c.parentId === null || isSnow(c.parentId)) || !(c.topic === null || isStr(c.topic, 1024)) || !Array.isArray(c.overwrites)) return null;
  const overwrites: DiscordOverwrite[] = [];
  for (const x of c.overwrites as unknown[]) {
    const o = obj(x);
    if (!o || !isSnow(o.id) || !(o.type === 0 || o.type === 1) || !isStr(o.allow, 30) || !BITS.test(o.allow) || !isStr(o.deny, 30) || !BITS.test(o.deny)) return null;
    overwrites.push({ id: o.id, type: o.type, allow: o.allow, deny: o.deny });
  }
  return { id: c.id, name: c.name, type: c.type, position: c.position, parentId: c.parentId as string | null, topic: c.topic as string | null, overwrites };
}

function roleFrom(v: unknown): DiscordRole | null {
  const r = obj(v);
  if (!r || !isSnow(r.id) || !isStr(r.name, 100) || !isInt(r.position) || !isStr(r.permissions, 30) || !BITS.test(r.permissions) || typeof r.managed !== "boolean") return null;
  const t = obj(r.tags);
  if (!t) return null;
  const tags: Record<string, string | null> = {};
  for (const [k, x] of Object.entries(t)) {
    if (!(x === null || isStr(x, 40))) return null;
    tags[k] = x;
  }
  return { id: r.id, name: r.name, position: r.position, permissions: r.permissions, managed: r.managed, tags };
}

/** The host's line (discord-read.js `guild`), checked field by field: null when any part is not in its shape. */
export function guildFrom(j: unknown): DiscordGuild | null {
  const o = obj(j);
  if (!o || o.v !== 1 || o.ok !== true) return null;
  const g = obj(o.guild), e = obj(o.emoji);
  if (!g || !isSnow(g.id) || !isStr(g.name, 100) || !isInt(g.premiumTier) || !e || !isInt(e.static) || !isInt(e.animated)) return null;
  if (!Array.isArray(o.channels) || !Array.isArray(o.roles) || o.channels.length > MAX_ITEMS || o.roles.length > MAX_ITEMS) return null;
  const all: DiscordChannel[] = [];
  for (const c of o.channels as unknown[]) { const x = channelFrom(c); if (!x) return null; all.push(x); }
  const roles: DiscordRole[] = [];
  for (const r of o.roles as unknown[]) { const x = roleFrom(r); if (!x) return null; roles.push(x); }
  if (!roles.some((r) => r.id === g.id)) return null; // @everyone (its id is the server's)
  return {
    id: g.id, name: g.name, premiumTier: g.premiumTier,
    categories: all.filter((c) => c.type === 4), channels: all.filter((c) => c.type !== 4), roles,
    emoji: { static: e.static, animated: e.animated },
    ...(isStr(o.readAt, 40) ? { readAt: o.readAt } : {}),
  };
}

// ── Discord's permissions ─────────────────────────────────────────────────────────────────────────

const P = {
  KICK: BigInt(1) << BigInt(1), BAN: BigInt(1) << BigInt(2), ADMIN: BigInt(1) << BigInt(3), MANAGE_CHANNELS: BigInt(1) << BigInt(4), MANAGE_GUILD: BigInt(1) << BigInt(5),
  VIEW: BigInt(1) << BigInt(10), SEND: BigInt(1) << BigInt(11), MANAGE_MESSAGES: BigInt(1) << BigInt(13), MANAGE_ROLES: BigInt(1) << BigInt(28), SEND_IN_THREADS: BigInt(1) << BigInt(38), MODERATE: BigInt(1) << BigInt(40),
};
// Every documented bit, for spelling an overwrite out; an unknown one reads bit<N>.
const BIT_NAMES = [
  "CREATE_INSTANT_INVITE", "KICK_MEMBERS", "BAN_MEMBERS", "ADMINISTRATOR", "MANAGE_CHANNELS", "MANAGE_GUILD",
  "ADD_REACTIONS", "VIEW_AUDIT_LOG", "PRIORITY_SPEAKER", "STREAM", "VIEW_CHANNEL", "SEND_MESSAGES",
  "SEND_TTS_MESSAGES", "MANAGE_MESSAGES", "EMBED_LINKS", "ATTACH_FILES", "READ_MESSAGE_HISTORY", "MENTION_EVERYONE",
  "USE_EXTERNAL_EMOJIS", "VIEW_GUILD_INSIGHTS", "CONNECT", "SPEAK", "MUTE_MEMBERS", "DEAFEN_MEMBERS", "MOVE_MEMBERS",
  "USE_VAD", "CHANGE_NICKNAME", "MANAGE_NICKNAMES", "MANAGE_ROLES", "MANAGE_WEBHOOKS", "MANAGE_GUILD_EXPRESSIONS",
  "USE_APPLICATION_COMMANDS", "REQUEST_TO_SPEAK", "MANAGE_EVENTS", "MANAGE_THREADS", "CREATE_PUBLIC_THREADS",
  "CREATE_PRIVATE_THREADS", "USE_EXTERNAL_STICKERS", "SEND_MESSAGES_IN_THREADS", "USE_EMBEDDED_ACTIVITIES",
  "MODERATE_MEMBERS", "VIEW_CREATOR_MONETIZATION_ANALYTICS", "USE_SOUNDBOARD", "CREATE_GUILD_EXPRESSIONS",
  "CREATE_EVENTS", "USE_EXTERNAL_SOUNDS", "SEND_VOICE_MESSAGES", null, null, "SEND_POLLS", "USE_EXTERNAL_APPS",
];
function bitNames(bits: string): string {
  const v = BigInt(bits);
  const out: string[] = [];
  for (let i = BigInt(0); (BigInt(1) << i) <= v; i++) if (v & (BigInt(1) << i)) out.push(BIT_NAMES[Number(i)] ?? `bit${i}`);
  return out.join("|");
}

const CHANNEL_KIND: Readonly<Record<number, string>> = { 0: "text", 2: "voice", 5: "announcement", 13: "stage", 15: "forum", 16: "media" };
const KEPT_REASON: Readonly<Record<string, string>> = {
  forum: "Forums stay on Discord: no bridge carries them yet.",
  voice: "Voice stays on Discord.",
  stage: "Stage channels are voice: they stay on Discord.",
  media: "Media channels stay on Discord: no bridge carries them yet.",
};

/** Discord's own reckoning for a member holding only @everyone and `role` (null = @everyone alone). */
function effective(ch: DiscordChannel, guildId: string, everyone: DiscordRole, role: DiscordRole | null): { view: boolean; send: boolean } {
  let base = BigInt(everyone.permissions) | (role ? BigInt(role.permissions) : BigInt(0));
  if (base & P.ADMIN) return { view: true, send: true };
  const ev = ch.overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (ev) { base &= ~BigInt(ev.deny); base |= BigInt(ev.allow); }
  const own = role ? ch.overwrites.find((o) => o.type === 0 && o.id === role.id) : undefined;
  if (own) { base &= ~BigInt(own.deny); base |= BigInt(own.allow); }
  const view = Boolean(base & P.VIEW);
  const sendBit = ch.type === 15 || ch.type === 16 ? P.SEND_IN_THREADS : P.SEND;
  return { view, send: view && Boolean(base & sendBit) };
}

// ── roles onto the ladder ─────────────────────────────────────────────────────────────────────────

const SUPPORTER_NAME = /\b(subs?|subscribers?|supporters?|patrons?|patreon|vip|donors?|boosters?|tier \d+)\b|ko-?fi/;

function sourceOf(name: string, signal: string): string {
  if (signal === "booster") return "booster";
  if (/twitch/.test(name)) return "twitch";
  if (/youtube/.test(name)) return "youtube";
  if (signal === "linked platform") return "platform";
  if (/patreon|patron/.test(name)) return "patreon";
  if (/ko-?fi/.test(name)) return "ko-fi";
  return "named";
}

/** A role's rung by Discord's signals, in spike 0.3's order. */
function classify(role: DiscordRole, guildId: string): { tier: Tier; signal: string } {
  if (role.id === guildId) return { tier: "member", signal: "@everyone" };
  const perms = BigInt(role.permissions);
  const name = role.name.toLowerCase();
  const tags = role.tags;
  if (tags.bot_id) return { tier: "bot", signal: "bot" };
  if (perms & P.ADMIN) return { tier: "admin", signal: "administrator" };
  if (/\b(owner|admin|admins|administrator)\b/.test(name)) return { tier: "admin", signal: "name" };
  if (/\bbots?\b/.test(name)) return { tier: "bot", signal: "name" };
  if (/\bstaff\b/.test(name)) return { tier: "staff", signal: "name" };
  if (/\b(mod|mods|moderator|moderators)\b/.test(name)) return { tier: "mod", signal: "name" };
  if ("premium_subscriber" in tags) return { tier: "supporter", signal: "booster" };
  if (tags.integration_id || "subscription_listing_id" in tags || "available_for_purchase" in tags) return { tier: "supporter", signal: "linked platform" };
  if (SUPPORTER_NAME.test(name)) return { tier: "supporter", signal: "name" };
  if (perms & (P.MANAGE_GUILD | P.MANAGE_ROLES | P.MANAGE_CHANNELS)) return { tier: "staff", signal: "manage permissions" };
  if (perms & (P.KICK | P.BAN | P.MANAGE_MESSAGES | P.MODERATE)) return { tier: "mod", signal: "mod permissions" };
  return { tier: "member", signal: "none" };
}

// ── the sentences ─────────────────────────────────────────────────────────────────────────────────

type Sentence<R> = { rule: R; level: number };
// Least restrictive first. "Invited people only" is the Admins alone (level above every rung).
const SEE: readonly Sentence<SeeRule>[] = [{ rule: "everyone", level: 0 }, { rule: "supporters", level: 10 }, { rule: "mods", level: 50 }, { rule: "staff", level: 75 }, { rule: "invited", level: 101 }];
const POST: readonly Sentence<PostRule>[] = [{ rule: "everyone", level: 0 }, { rule: "supporters", level: 10 }, { rule: "mods", level: 50 }, { rule: "staff", level: 75 }];

type Reduced<R> = { rule: R; exact: boolean; extra: string[]; missing: string[] };

/** The sentence for the set of roles Discord lets in (`actual`), among `scope` (for posting: those who can see). */
function reduce<R>(sentences: readonly Sentence<R>[], actual: Set<string>, tierOf: Map<string, Tier>, scope: string[]): Reduced<R> {
  const implied = (s: Sentence<R>) => new Set(scope.filter((id) => tierOf.get(id) === "admin" || LEVEL[tierOf.get(id)!] >= s.level));
  const same = (a: Set<string>) => a.size === actual.size && [...a].every((id) => actual.has(id));
  const exact = sentences.filter((s) => same(implied(s)));
  if (exact.length) {
    const adminsOnly = [...actual].every((id) => tierOf.get(id) === "admin");
    return { rule: (adminsOnly ? exact[exact.length - 1]! : exact[0]!).rule, exact: true, extra: [], missing: [] };
  }
  const within = sentences.find((s) => [...implied(s)].every((id) => actual.has(id))) ?? sentences[sentences.length - 1]!;
  const set = implied(within);
  return { rule: within.rule, exact: false, extra: [...set].filter((id) => !actual.has(id)), missing: [...actual].filter((id) => !set.has(id)) };
}

const byPosition = (a: { position: number; id: string }, b: { position: number; id: string }) =>
  a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;
const cleanName = (s: string, fallback: string) => s.replace(CONTROL, "").trim().slice(0, 100) || fallback;

/** The community a Discord server would become, with what does not map said out loud. */
export function proposeCommunity(guild: DiscordGuild, rules: ImportRules = {}): Proposal {
  const everyone = guild.roles.find((r) => r.id === guild.id)!;
  const tierOf = new Map<string, Tier>();
  const roleMap: RoleMapping[] = guild.roles.slice().sort((a, b) => b.position - a.position || byPosition(a, b)).map((r) => {
    const c = classify(r, guild.id);
    const chosen = r.id !== guild.id ? rules.roleTiers?.[r.id] : undefined;
    const tier = chosen && TIERS.includes(chosen) ? chosen : c.tier;
    tierOf.set(r.id, tier);
    const ask = c.tier === "mod" && Boolean(BigInt(r.permissions) & P.MANAGE_CHANNELS);
    return { id: r.id, name: r.name, tier, signal: c.signal, source: tier === "supporter" ? sourceOf(r.name.toLowerCase(), c.signal) : null, ask };
  });
  const roleById = new Map(guild.roles.map((r) => [r.id, r]));
  const people = guild.roles.filter((r) => tierOf.get(r.id) !== "bot").map((r) => r.id);
  const named = (ids: string[]) => ids.map((id) => `${id === guild.id ? "@everyone" : roleById.get(id)?.name ?? id} (${TIER_WORDS[tierOf.get(id) ?? "member"]})`).join(", ");
  const who = (o: DiscordOverwrite) => (o.type === 1 ? `one person (${o.id})` : o.id === guild.id ? "@everyone" : roleById.get(o.id)?.name ?? `a role (${o.id})`);
  const spell = (o: DiscordOverwrite) => `${who(o)}: ${[o.allow !== "0" ? `allow ${bitNames(o.allow)}` : "", o.deny !== "0" ? `deny ${bitNames(o.deny)}` : ""].filter(Boolean).join("; ") || "nothing"}`;

  const cats = guild.categories.slice().sort(byPosition);
  const byParent = new Map<string, DiscordChannel[]>();
  const catIds = new Set(cats.map((c) => c.id));
  for (const c of guild.channels) {
    const k = c.parentId && catIds.has(c.parentId) ? c.parentId : "";
    byParent.set(k, [...(byParent.get(k) ?? []), c]);
  }

  const rooms: ProposedRoom[] = [];
  const kept: Proposal["kept"] = [];
  const needsChoice: Proposal["needsChoice"] = [];
  for (const group of [{ cat: null as DiscordChannel | null, list: byParent.get("") ?? [] }, ...cats.map((c) => ({ cat: c, list: byParent.get(c.id) ?? [] }))]) {
    for (const ch of group.list.slice().sort(byPosition)) {
      const kind = CHANNEL_KIND[ch.type] ?? "other";
      const spaceDiscordId = group.cat?.id ?? null;
      if (ch.type !== 0 && ch.type !== 5) {
        kept.push({ discordId: ch.id, name: ch.name, kind, spaceDiscordId, reason: KEPT_REASON[kind] ?? "This kind of channel stays on Discord." });
        continue;
      }
      const viewers = new Set<string>(), senders = new Set<string>();
      for (const id of people) {
        const e = effective(ch, guild.id, everyone, id === guild.id ? null : roleById.get(id)!);
        if (e.view) viewers.add(id);
        if (e.send) senders.add(id);
      }
      const see = reduce(SEE, viewers, tierOf, people);
      const post = reduce(POST, senders, tierOf, [...viewers]);
      let postRule = post.rule;
      let note: string | null = null;
      const announcement = ch.type === 5;
      if (announcement && (post.rule === "everyone" || post.rule === "supporters")) {
        // An overwrite that names SEND for a group below the mods is Discord saying so on purpose.
        const explicit = ch.overwrites.some((o) => o.type === 0 && (BigInt(o.allow) & P.SEND)
          && (o.id === guild.id || LEVEL[tierOf.get(o.id) ?? "member"] < LEVEL.mod));
        if (!explicit) {
          postRule = "mods";
          note = `Discord lets ${post.rule === "everyone" ? "everyone" : "supporters"} post here; an announcement channel takes Mods and above. Choose ${POST_WORDS[post.rule]} to keep Discord's.`;
        }
      }
      rooms.push({ discordId: ch.id, spaceDiscordId, name: cleanName(ch.name, "channel"), kind: announcement ? "announcement" : "text", topic: ch.topic,
        see: see.rule, post: postRule, exact: see.exact && post.exact, note });
      const words: string[] = [];
      const lossy = (label: string, text: string, r: Reduced<string>) => {
        const parts = [r.extra.length ? `also lets in ${named(r.extra)}` : "", r.missing.length ? `leaves out ${named(r.missing)}` : ""].filter(Boolean);
        words.push(`${label}: no sentence matches Discord. "${text}" ${parts.join(", and ")}.`);
      };
      if (!see.exact) lossy("Who can see", SEE_WORDS[see.rule], see);
      if (!post.exact) lossy("Who can post", POST_WORDS[post.rule], post);
      const persons = ch.overwrites.filter((o) => o.type === 1).length;
      if (persons) words.push(`${persons} overwrite${persons === 1 ? "" : "s"} for one person each cannot be written as a sentence.`);
      if (words.length) needsChoice.push({ discordId: ch.id, name: ch.name, words, overwrites: ch.overwrites.map(spell) });
    }
  }
  const used = new Set(rooms.map((r) => r.spaceDiscordId));
  const limit = ({ 0: 50, 1: 100, 2: 150, 3: 250 } as Record<number, number>)[guild.premiumTier] ?? 50;
  return {
    guild: { id: guild.id, name: guild.name },
    spaces: cats.filter((c) => used.has(c.id)).map((c) => ({ discordId: c.id, name: cleanName(c.name, "category") })),
    rooms, roleMap, kept, needsChoice,
    emoji: { static: guild.emoji.static, animated: guild.emoji.animated, limit, fits: guild.emoji.static <= limit && guild.emoji.animated <= limit },
  };
}

// ── a second import: what is here already ─────────────────────────────────────────────────────────

export type ImportedHere = {
  hubId: number | null;
  spaces: { id: number; discordImportId: string | null; name: string }[];
  rooms: { id: number; discordImportId: string | null; spaceId: number; name: string; see: SeeRule; post: PostRule; discordChannelId: string | null }[];
};
type Change = { field: "name" | "see" | "post"; discord: string; here: string };
export type ImportDiff = {
  spaces: { discordId: string; status: "new" | "same" | "changed"; rowId: number | null; changes: Change[] }[];
  rooms: { discordId: string; status: "new" | "same" | "changed"; rowId: number | null; changes: Change[]; clash: boolean; linked: boolean; hereName: string | null }[];
  /** Rows imported from a channel the server no longer has: kept here, never deleted. */
  gone: { rowId: number; name: string }[];
};

/** The proposal against the rows: new, the same, or changed (on either side: the panel cannot tell which). */
export function diffImport(p: Proposal, here: ImportedHere): ImportDiff {
  const spaceRow = new Map(here.spaces.filter((s) => s.discordImportId).map((s) => [s.discordImportId!, s]));
  const roomRow = new Map(here.rooms.filter((r) => r.discordImportId).map((r) => [r.discordImportId!, r]));
  const spaces = p.spaces.map((s) => {
    const row = spaceRow.get(s.discordId);
    if (!row) return { discordId: s.discordId, status: "new" as const, rowId: null, changes: [] };
    const changes: Change[] = row.name === s.name ? [] : [{ field: "name", discord: s.name, here: row.name }];
    return { discordId: s.discordId, status: changes.length ? "changed" as const : "same" as const, rowId: row.id, changes };
  });
  const rooms = p.rooms.map((r) => {
    const row = roomRow.get(r.discordId);
    if (!row) {
      const target = r.spaceDiscordId ? spaceRow.get(r.spaceDiscordId)?.id ?? null : here.hubId;
      const clash = target !== null && here.rooms.some((x) => x.spaceId === target && x.name.toLowerCase() === r.name.toLowerCase());
      return { discordId: r.discordId, status: "new" as const, rowId: null, changes: [], clash, linked: false, hereName: null };
    }
    const changes: Change[] = [];
    if (row.name !== r.name) changes.push({ field: "name", discord: r.name, here: row.name });
    if (row.see !== r.see) changes.push({ field: "see", discord: r.see, here: row.see });
    if (row.post !== r.post) changes.push({ field: "post", discord: r.post, here: row.post });
    return { discordId: r.discordId, status: changes.length ? "changed" as const : "same" as const, rowId: row.id, changes, clash: false, linked: !!row.discordChannelId, hereName: row.name };
  });
  const proposed = new Set(p.rooms.map((r) => r.discordId));
  const gone = here.rooms.filter((r) => r.discordImportId && !proposed.has(r.discordImportId)).map((r) => ({ rowId: r.id, name: r.name }));
  return { spaces, rooms, gone };
}

// ── the confirm ───────────────────────────────────────────────────────────────────────────────────

export type ImportChoices = {
  /** Per Discord channel: include it (new: default yes; changed: default no), and the streamer's edits. */
  rooms: Record<string, { include?: boolean; name?: string; see?: SeeRule; post?: PostRule }>;
  /** Per Discord category: its name here. */
  spaces: Record<string, { name?: string }>;
};
export type SpaceRef = { hub: true } | { rowId: number } | { discordId: string };
export type ImportPlan = {
  newSpaces: { discordId: string; name: string }[];
  newRooms: { discordId: string; spaceRef: SpaceRef; kind: "text" | "announcement"; name: string; topic: string | null; see: SeeRule; post: PostRule; published: boolean; retentionDays: number | null }[];
  updates: { rowId: number; discordId: string; name: string; see: SeeRule; post: PostRule; published: boolean }[];
};

/** A channel as validateRoomInput reads it (the shared rules: names, sentences, publish follows see). */
function checked(name: string, kind: "text" | "announcement", see: unknown, post: unknown): { name: string; see: SeeRule; post: PostRule } | { error: string } {
  const r = validateRoomInput({ id: 0, spaceId: 0, kind, name, topic: null, avatarMxc: null, orderKey: "a0", see, post, retentionDays: null,
    encrypted: false, published: see === "everyone", archived: false, matrixRoomId: null, discordChannelId: null });
  return "error" in r ? r : { name: r.name, see: r.see, post: r.post };
}
const typedName = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim().replace(/^#+/, "").trim() : fallback);

/** What a confirm writes, every edit checked; the first problem refuses the whole confirm. */
export function importPlan(p: Proposal, d: ImportDiff, choices: ImportChoices, opts: { retentionCapDays?: number } = {}): ImportPlan | { error: string } {
  const cap = opts.retentionCapDays ?? 365;
  const status = new Map(d.rooms.map((r) => [r.discordId, r]));
  const spaceDiff = new Map(d.spaces.map((s) => [s.discordId, s]));
  const plan: ImportPlan = { newSpaces: [], newRooms: [], updates: [] };
  const wanted = new Set<string>();
  for (const r of p.rooms) {
    const st = status.get(r.discordId);
    const c = choices.rooms[r.discordId] ?? {};
    if (!st || st.status === "same") continue;
    if (!(c.include ?? st.status === "new")) continue;
    const ok = checked(typedName(c.name, r.name), r.kind, c.see ?? r.see, c.post ?? r.post);
    if ("error" in ok) return { error: `#${r.name}: ${ok.error}` };
    if (st.status === "changed") {
      // What the row holds now: the proposal where nothing differs, the row's own value where it does.
      const now: Record<Change["field"], string> = { name: r.name, see: r.see, post: r.post };
      for (const ch of st.changes) now[ch.field] = ch.here;
      // The edit is what the row already holds (a retry of a confirm, or a name kept from the first import).
      if (now.name === ok.name && now.see === ok.see && now.post === ok.post) continue;
      if (st.linked && (ok.see !== "everyone" || ok.post !== "everyone")) return { error: `#${st.hereName ?? r.name} is linked to Discord: unlink it before it is narrowed.` };
      plan.updates.push({ rowId: st.rowId!, discordId: r.discordId, ...ok, published: ok.see === "everyone" });
      continue;
    }
    const sd = r.spaceDiscordId ? spaceDiff.get(r.spaceDiscordId) : null;
    const spaceRef: SpaceRef = !r.spaceDiscordId ? { hub: true } : sd && sd.rowId !== null ? { rowId: sd.rowId } : { discordId: r.spaceDiscordId };
    if (r.spaceDiscordId && !(sd && sd.rowId !== null)) wanted.add(r.spaceDiscordId);
    plan.newRooms.push({ discordId: r.discordId, spaceRef, kind: r.kind, topic: r.topic, ...ok, published: ok.see === "everyone", retentionDays: defaultKeepDays(r.kind, cap) });
  }
  for (const s of p.spaces) {
    if (!wanted.has(s.discordId)) continue;
    const name = typedName(choices.spaces[s.discordId]?.name, s.name);
    if (!name || name.length > 100 || /[\u0000-\u001F\u007F-\u009F]/.test(name)) return { error: `${s.name}: A category name is 1 to 100 characters.` };
    plan.newSpaces.push({ discordId: s.discordId, name });
  }
  return plan;
}
