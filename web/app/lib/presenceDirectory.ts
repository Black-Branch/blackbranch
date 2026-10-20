// What GET /api/presence tells one signed-in viewer about everyone else. Pure, so the disclosure
// rules are tested without a database (presenceDirectory.test.ts); presenceServer.ts runs the query.
//
// The rules:
//   • `supporter` is shown for someone else only when chat already shows it: they wear the
//     subscriber badge (the same decision GET /api/badges makes — shapeBadgeUserState). An
//     entitlement nobody displays is private; the caller always learns their own.
//   • `lastLogin` (a day-rounded activity signal) goes only to the caller, for their own row.
//   • An invisible person is the id and nothing else: no beats, no status, no supporter, no login.
//     They are still listed — an omitted row would itself be a tell — and read exactly like any
//     member with no recent beat.
//   • Beat timestamps are rounded down to 30 s; the two counts use the raw values and the same
//     windows as presenceState.deriveState (imported, never re-typed), and skip an invisible row.
import type { BadgeSnapshot } from "./badgeCache.ts";
import { entitledSet, publicBadgeStates, subscriberBadgeIds } from "./publicBadges.ts";
import { HERE_MS, AWAY_AFTER_MS, type SitePresenceRow, type PresenceDirectory } from "./presenceState.ts";

export type DirRow = {
  matrix_id: string; last_beat: Date | null; last_visible: Date | null; last_community: Date | null;
  /** Only ever selected for the caller's own row (null for everyone else). */
  last_login: Date | null; status: string; status_text: string;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const ROUND_MS = 30_000;
const roundDown30s = (d: Date | null): Date | null => (d ? new Date(Math.floor(d.getTime() / ROUND_MS) * ROUND_MS) : null);
const dayStartUtc = (d: Date | null): Date | null =>
  d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null;

/** Who is entitled (staff, an active subscription, an unexpired gift) and, of those, who wears
 *  the subscriber badge where chat shows it — GET /api/badges' decision, from the same snapshot. */
export function supporterSets(snap: Pick<BadgeSnapshot, "cat" | "slots" | "mods" | "subs" | "gifts">, staff: ReadonlySet<string>): {
  entitled: Set<string>; badgeShown: Set<string>;
} {
  const entitled = entitledSet(snap, staff);
  const subIds = subscriberBadgeIds(snap);
  const badgeShown = new Set<string>();
  for (const [id, state] of publicBadgeStates(snap, staff, entitled)) {
    if (state.equipped.some((b) => b != null && subIds.has(b))) badgeShown.add(id);
  }
  return { entitled, badgeShown };
}

export function shapePresenceDirectory(rows: DirRow[], opts: {
  me: string; now: number; entitled: ReadonlySet<string>; badgeShown: ReadonlySet<string>;
}): PresenceDirectory {
  const { me, now } = opts;
  const users: Record<string, SitePresenceRow> = {};
  let onSite = 0;
  let inCommunity = 0;
  for (const r of rows) {
    const self = r.matrix_id === me;
    const invisible = r.status === "invisible";
    if (!invisible) {
      const beat = r.last_beat?.getTime() ?? 0;
      const visible = r.last_visible?.getTime() ?? 0;
      if (beat > now - HERE_MS && visible > now - AWAY_AFTER_MS) {
        onSite += 1;
        if ((r.last_community?.getTime() ?? 0) > now - HERE_MS) inCommunity += 1;
      }
    }
    const hidden = invisible && !self;
    users[r.matrix_id] = {
      lastBeat: invisible ? null : iso(roundDown30s(r.last_beat)),
      lastVisible: invisible ? null : iso(roundDown30s(r.last_visible)),
      lastCommunity: invisible ? null : iso(roundDown30s(r.last_community)),
      lastLogin: self ? iso(dayStartUtc(r.last_login)) : null,
      status: invisible ? "online" : r.status === "idle" || r.status === "dnd" ? r.status : "online",
      statusText: invisible ? "" : r.status_text,
      supporter: hidden ? false : self ? opts.entitled.has(r.matrix_id) : opts.badgeShown.has(r.matrix_id),
    };
  }
  return { counts: { onSite, inCommunity }, users };
}
