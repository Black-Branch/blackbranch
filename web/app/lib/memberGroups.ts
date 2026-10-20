import type { PresenceState } from "./presenceState";

// The members list's categories, order and fold. Pure — the list
// builds MemberViews from RoomMembers + the presence directory and hands them
// here; memberGroups.test.ts pins the rules on plain objects.

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

export type Category = "admin" | "mods" | "supporters" | "members" | "discord";

const CATEGORY_LABEL: Record<Category, string> = {
  admin: "Admin",
  mods: "Moderators",
  supporters: "Supporters",
  members: "Members",
  discord: "Discord",
};

const ORDER: Category[] = ["admin", "mods", "supporters", "members", "discord"];

/** First category that fits. Power level wins over the bridge: a bridged
 *  member with power ≥ 50 is a Moderator; ghosts fall to Discord only from
 *  Members (they are never Supporters — they never log in). */
function categorize(m: MemberView): Category {
  if (m.powerLevel >= 100) return "admin";
  if (m.powerLevel >= 50) return "mods";
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

export function groupMembers(members: MemberView[]): {
  groups: { key: Category; label: string; members: MemberView[] }[];
  inactive: MemberView[];
} {
  const buckets = new Map<Category, MemberView[]>();
  const inactive: MemberView[] = [];
  for (const m of members) {
    const cat = categorize(m);
    if (m.inactive && cat !== "discord") { inactive.push(m); continue; }
    const list = buckets.get(cat) ?? [];
    list.push(m);
    buckets.set(cat, list);
  }
  const groups = ORDER.filter((k) => buckets.has(k)).map((k) => ({
    key: k,
    label: CATEGORY_LABEL[k],
    members: (buckets.get(k) ?? []).sort(byRankThenLabel),
  }));
  return { groups, inactive: inactive.sort(byLabel) };
}
