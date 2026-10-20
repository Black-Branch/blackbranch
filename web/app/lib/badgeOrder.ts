// The order badges render in before a username.
//
// Kept apart from BadgesContext.tsx so the ordering rule is testable on its
// own — the context is a "use client" React module that `node --test` cannot
// import, and an ordering rule pinned only by a source regex is barely pinned.

import type { BadgeUserState } from "./badgeSlots";

// Structural, not the context's full BadgesState — this needs three fields, and
// depending on the whole shape would drag React into the test.
export type BadgeOrderInput = {
  byId: Record<number, BadgeDefLike>;
  perUser: Record<string, BadgeUserState>;
  modBadgeId: number | null;
};

export type BadgeDefLike = { id: number; name: string; imageUrl: string };

/**
 * Badges to render before a Matrix user's name: their equipped badges in slot
 * order (only slots still unlocked), then the fixed mod badge.
 *
 * MOD GOES LAST, so a subscribed mod reads subscriber/mod, not mod/subscriber.
 *
 * The subscriber badge is not special-cased, and that is deliberate: it is just
 * an equipped badge like any other, so the user's own slot order decides where
 * it sits. Hoisting it explicitly would make slot 1 mean nothing for
 * subscribers and leave the two orderings fighting each other. Treating the
 * fixed mod badge as a SUFFIX gets that order and leaves the slots honest.
 *
 * Matrix-anchored — cross-platform-only chatters have no badges.
 */
export function badgesInRenderOrder(
  state: BadgeOrderInput,
  matrixId: string | null | undefined
): BadgeDefLike[] {
  if (!matrixId) return [];
  const u = state.perUser[matrixId];
  if (!u) return [];

  const out: BadgeDefLike[] = [];
  const n = Math.min(u.slotCount, u.equipped.length);
  for (let i = 0; i < n; i++) {
    const bid = u.equipped[i];
    if (bid != null) {
      const b = state.byId[bid];
      if (b) out.push(b);
    }
  }
  if (u.isMod && state.modBadgeId != null) {
    const mod = state.byId[state.modBadgeId];
    if (mod) out.push(mod);
  }
  return out;
}
