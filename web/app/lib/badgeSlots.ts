// Badge-slot model shared by the API + client. See migrate-v60.
//
// A user has a fixed row of MAX_SLOTS positions. A slot is UNLOCKED when its index
// is below the user's effective slot count (base_slots + a live +1 for an active
// subscription); an unlocked slot can hold one EQUIPPED badge that the user has
// also unlocked (site.badge_unlocks). The mod badge is fixed, off-slot, and shown
// separately. See app/api/badges + BadgesContext.

export const MAX_SLOTS = 3;

// Per-user badge state returned by GET /api/badges.
export interface BadgeUserState {
  /** Effective number of unlocked slots (base + subscription), capped at MAX_SLOTS. */
  slotCount: number;
  /** Badge equipped per slot (1-based in the DB, 0-based here); null = empty slot. */
  equipped: (number | null)[];
  /** Badge ids this user may equip. */
  unlocked: number[];
  /** Wears the fixed mod badge (off-slot). */
  isMod: boolean;
}

/**
 * Shape one user's entry for the PUBLIC GET /api/badges response.
 * Returns null when the user should be omitted entirely.
 *
 * Presence in that response is itself information: the caller builds the id set
 * from mods ∪ subscribers ∪ gift recipients ∪ unlock owners, so merely appearing
 * would disclose membership on a public, every-client-polled endpoint. For
 * anyone but the caller we therefore emit only what chat already renders in
 * public — the mod badge and equipped badges — and omit users with nothing to
 * render.
 *
 * Pure so the disclosure rule is testable without a database.
 *
 * @param isSelf caller's own entry — gets owned slots + private inventory
 */
export function shapeBadgeUserState(args: {
  isSelf: boolean;
  ownedSlotCount: number;
  equipped: (number | null)[];
  unlocked: number[];
  isMod: boolean;
  /** Live subscription/gift entitlement (staff count as entitled). */
  entitled: boolean;
  /** Badge ids that require live entitlement to WEAR (is_subscriber defs). */
  subscriberBadgeIds: ReadonlySet<number>;
}): BadgeUserState | null {
  const { isSelf, ownedSlotCount, equipped, unlocked, isMod, entitled, subscriberBadgeIds } = args;

  // A subscriber-gated badge is WORN only while entitlement is live.
  // site.badge_slots.equipped deliberately persists across a lapse —
  // resubscribing restores the badge with no re-equip — and gift subscriptions
  // expire by TIME with no webhook event, so the mask lives HERE, at the one
  // point every render flows through, not in a transition handler a gift lapse
  // never fires. The equip route separately 403s fresh equips (belt); this
  // closes the resurface path (lapse → buy a slot → the stale equipped entry
  // reappears with no equip call for the route to refuse).
  const worn = equipped.map((id) =>
    id != null && subscriberBadgeIds.has(id) && !entitled ? null : id);

  if (isSelf) {
    // Self sees the mask too — the equip UI must agree with what chat shows,
    // not claim a badge the rest of the room can't see.
    return { slotCount: ownedSlotCount, equipped: worn, unlocked, isMod };
  }

  // Only slots in use, and only ones they actually hold.
  const visible = worn.slice(0, ownedSlotCount);
  while (visible.length && visible[visible.length - 1] == null) visible.pop();
  if (!isMod && visible.length === 0) return null;

  return {
    // Sized to what is DISPLAYED, not what is OWNED — an unequipped extra slot
    // is exactly the subscription signal we are hiding.
    slotCount: visible.length,
    equipped: visible,
    unlocked: [],
    isMod,
  };
}
