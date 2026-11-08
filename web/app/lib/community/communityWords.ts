// The words the Community page shows for a channel's rules (spec 2026-10-23 §4.3-§4.5). Plain
// sentences only: no Matrix terms anywhere a streamer reads.
import type { PostRule, RoomKind, SeeRule } from "./desired.ts";

/** Who can see, in the panel's order. */
export const SEE_WORDS: Readonly<Record<SeeRule, string>> = {
  everyone: "Everyone in the community",
  supporters: "Supporters and above",
  mods: "Mods and above",
  staff: "Staff and above",
  invited: "Invited people only",
};

/** Who can post, in the panel's order. */
export const POST_WORDS: Readonly<Record<PostRule, string>> = {
  everyone: "Everyone who can see",
  supporters: "Supporters and above",
  staff: "Staff and above",
  mods: "Mods and above",
};

export const KIND_WORDS: Readonly<Record<RoomKind, string>> = { text: "Text", announcement: "Announcement", forum: "Forum" };

/** "Who can see: … · Who can post: …" */
export function rulesSentence(r: { see: SeeRule; post: PostRule }): string {
  return `Who can see: ${SEE_WORDS[r.see]} · Who can post: ${POST_WORDS[r.post]}`;
}

/** The ten-year ceiling a channel's days stay under when the install has no cap (the v165 CHECK). */
const KEEP_CEILING_DAYS = 3650;

/** The days a channel may pick: up to the install's cap, or the ceiling when the cap is 0 (no limit). */
export const keepMaxDays = (cap: number) => (cap > 0 ? cap : KEEP_CEILING_DAYS);

/** What a channel with no days of its own (null) keeps: the server's limit (the reconciler writes
 *  the install's cap on it), or forever only when the install has no cap. */
function noDaysWords(cap: number): string {
  return cap > 0 ? `As long as this server allows (${cap} days)` : "Forever";
}

/** How long a channel keeps its messages. */
export function keepWords(days: number | null, cap: number): string {
  if (days === null) return `Keeps messages: ${noDaysWords(cap)}`;
  return `Keeps messages: ${days} day${days === 1 ? "" : "s"}`;
}

/** What encryption costs, said before it is switched on (spec §4.4). */
export const ENCRYPTION_COSTS: readonly string[] = [
  "It cannot be switched off later.",
  "Server search cannot see it.",
  "Mods who are not members and the site's word filter cannot read it.",
  "A Discord-linked copy is plain text on Discord.",
  "Newcomers see earlier messages only if key sharing for past messages works.",
  "A lost device without backup loses history.",
];
/** The forum's extra cost (spec §4.4). */
export const FORUM_ENCRYPTION_COST = "Signed-out readers cannot see an encrypted forum.";

/** A new channel's days (ADR 0139: chat 30 days; announcements and forums no limit of their own),
 *  within the install's cap. */
export function defaultKeepDays(kind: RoomKind, cap: number): number | null {
  return kind === "text" ? Math.min(30, keepMaxDays(cap)) : null;
}
