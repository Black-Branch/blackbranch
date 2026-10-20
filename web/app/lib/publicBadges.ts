// What chat shows of a person's badges, to someone who is not them — the same answer GET
// /api/badges gives in `perUser` (entitlement = staff, an active subscription or an unexpired
// gift; staff never get the automatic mod badge; shapeBadgeUserState masks the rest). For the
// routes that must hand out a person's badges WITHOUT handing out their Matrix id (the credit
// overlay) and for the presence directory's supporter flag.
import type { BadgeSnapshot } from "./badgeCache.ts";
import { shapeBadgeUserState, MAX_SLOTS, type BadgeUserState } from "./badgeSlots.ts";

type Snap = Pick<BadgeSnapshot, "cat" | "slots" | "mods" | "subs" | "gifts">;

/** Staff + every active subscription + every unexpired gift. */
export function entitledSet(snap: Pick<Snap, "subs" | "gifts">, staff: ReadonlySet<string>): Set<string> {
  const entitled = new Set<string>(staff);
  for (const r of snap.subs) if (r.matrix_id) entitled.add(r.matrix_id);
  for (const r of snap.gifts) if (r.matrix_id) entitled.add(r.matrix_id);
  return entitled;
}

export function subscriberBadgeIds(snap: Pick<Snap, "cat">): Set<number> {
  return new Set(snap.cat.filter((d) => d.is_subscriber).map((d) => Number(d.id)));
}

/** The public badge state of each of `ids` that renders anything (absent = nothing to show). */
export function publicBadgeStates(snap: Snap, staff: ReadonlySet<string>, ids: Iterable<string>): Map<string, BadgeUserState> {
  const entitled = entitledSet(snap, staff);
  const subIds = subscriberBadgeIds(snap);
  const mods = new Set(snap.mods.map((r) => r.matrix_id).filter((id) => !staff.has(id)));
  const slots = new Map(snap.slots.map((s) => [s.matrix_id, s]));
  const out = new Map<string, BadgeUserState>();
  for (const id of ids) {
    const s = slots.get(id);
    const shaped = shapeBadgeUserState({
      isSelf: false,
      ownedSlotCount: Math.min(MAX_SLOTS, (Number(s?.base_slots) || 0) + (entitled.has(id) ? 1 : 0)),
      equipped: (s?.equipped ?? []).map((x) => (x == null ? null : Number(x))),
      unlocked: [], isMod: mods.has(id), entitled: entitled.has(id), subscriberBadgeIds: subIds,
    });
    if (shaped) out.set(id, shaped);
  }
  return out;
}
