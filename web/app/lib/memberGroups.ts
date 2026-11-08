import type { PresenceState } from "./presenceState";
import type { RoleRow } from "./community/desired";

// The members list's categories, order and fold. Pure — the list
// builds MemberViews from RoomMembers + the presence directory and hands them
// here with the server's ladder; memberGroups.test.ts pins the rules on plain objects.

export type MemberView = {
  userId: string;
  /** The rendered name (senderLabel already applied). */
  label: string;
  powerLevel: number;
  fromDiscord: boolean;
  supporter: boolean;
  state: PresenceState;
  inactive: boolean;
};

/** What the server says about the community's people (GET /api/community/mods). Empty lists are
 *  an older server's answer: nobody hidden, the default ladder. */
export type MemberLadder = {
  roles: RoleRow[];
  staffIds: string[];
  botIds: string[];
  /** Accounts no member list shows: the service account, the forum reader. */
  hiddenIds: string[];
};

export type MemberBadge = { rung: "streamer" | "staff" | "mods" | "bots"; label: string };

export type Category ="streamer" | "staff" | "mods" | "bots" | "supporters" | "members" | "discord";

const ORDER: Category[] = ["streamer", "staff", "mods", "bots", "supporters", "members", "discord"];

/** The ladder role each category is drawn from (its level, label, colour and hoist). */
const ROLE_OF: Partial<Record<Category, string>> = {
  streamer: "admin", staff: "staff", mods: "mod", bots: "bot", supporters: "supporter", members: "member",
};

/** The default ladder's levels (desired.ts DEFAULT_ROLES), for a server that sends none. */
const DEFAULT_LEVEL: Record<string, number> = { admin: 100, staff: 75, mod: 50, bot: 50 };

/** A default label read as a group heading; a role the streamer renamed shows its own name. */
const HEADING: Record<string, string> = {
  Admin: "Streamer", Staff: "Staff", Mod: "Mods", Bot: "Bots", Supporter: "Supporters", Member: "Members",
};
const FALLBACK_HEADING: Record<Category, string> = {
  streamer: "Streamer", staff: "Staff", mods: "Mods", bots: "Bots", supporters: "Supporters", members: "Members", discord: "Discord",
};

/** A row's badge: the rung in one plain word. A role the streamer renamed shows its own name. */
const BADGE: Partial<Record<Category, { defaultLabel: string; word: string }>> = {
  streamer: { defaultLabel: "Admin", word: "Streamer" },
  staff: { defaultLabel: "Staff", word: "Staff" },
  mods: { defaultLabel: "Mod", word: "Mod" },
  bots: { defaultLabel: "Bot", word: "Bot" },
};

const NO_LADDER: MemberLadder = { roles: [], staffIds: [], botIds: [], hiddenIds: [] };

/** First category that fits. A bot is a Bot whatever its power; then the rungs by the ladder's
 *  levels (the site's Staff role counts as Staff at any power); the bridge before Supporters —
 *  ghosts never log in, so they are never Supporters. */
function categorize(m: MemberView, level: (key: string) => number, staff: Set<string>, bots: Set<string>): Category {
  if (bots.has(m.userId)) return "bots";
  if (m.powerLevel >= level("admin")) return "streamer";
  if (staff.has(m.userId) || m.powerLevel >= level("staff")) return "staff";
  if (m.powerLevel >= level("mod")) return "mods";
  if (m.fromDiscord) return "discord";
  if (m.supporter) return "supporters";
  return "members";
}

/** community = site (both "here"), then elsewhere, then away = dnd, then offline. */
const STATE_RANK: Record<PresenceState, number> = {
  community: 0, site: 0, elsewhere: 1, away: 2, dnd: 2, offline: 3,
};

const byRankThenLabel = (a: MemberView, b: MemberView) =>
  STATE_RANK[a.state] - STATE_RANK[b.state] || a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
const byLabel = (a: MemberView, b: MemberView) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

export function groupMembers(members: MemberView[], ladder: MemberLadder = NO_LADDER): {
  groups: { key: Category; label: string; colour: string | null; members: MemberView[] }[];
  inactive: MemberView[];
  /** userId → the rung and its badge word for members on one (Streamer, Staff, Mod, Bot); others have none. */
  badges: Map<string, MemberBadge>;
} {
  const roles = new Map(ladder.roles.map((r) => [r.key, r]));
  const level = (key: string) => roles.get(key)?.level ?? DEFAULT_LEVEL[key] ?? Infinity;
  const hidden = new Set(ladder.hiddenIds);
  const staff = new Set(ladder.staffIds);
  const bots = new Set(ladder.botIds);
  const roleOf = (cat: Category) => (ROLE_OF[cat] ? roles.get(ROLE_OF[cat]) : undefined);

  const buckets = new Map<Category, MemberView[]>();
  const inactive: MemberView[] = [];
  const badges = new Map<string, MemberBadge>();
  for (const m of members) {
    if (hidden.has(m.userId)) continue;
    let cat = categorize(m, level, staff, bots);
    // The badge follows the rung, before any fold: a role that is not hoisted still says what it is.
    const badge = BADGE[cat];
    if (badge) {
      const label = roleOf(cat)?.label;
      badges.set(m.userId, { rung: cat as MemberBadge["rung"], label: !label || label === badge.defaultLabel ? badge.word : label });
    }
    // A role the ladder does not hoist is not a group of its own: its people are listed with Members.
    if (roleOf(cat)?.hoist === false) cat = "members";
    if (m.inactive && cat !== "discord") { inactive.push(m); continue; }
    const list = buckets.get(cat) ?? [];
    list.push(m);
    buckets.set(cat, list);
  }
  const groups = ORDER.filter((k) => buckets.has(k)).map((k) => {
    const role = roleOf(k);
    return {
      key: k,
      label: role ? HEADING[role.label] ?? role.label : FALLBACK_HEADING[k],
      colour: role?.colour ?? null,
      members: (buckets.get(k) ?? []).sort(byRankThenLabel),
    };
  });
  return { groups, inactive: inactive.sort(byLabel), badges };
}
