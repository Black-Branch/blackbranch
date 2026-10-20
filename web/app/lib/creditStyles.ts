// The credit overlay's per-name answer (GET /api/overlay/credit-styles): how chat draws that name
// — colour, equipped style, and the badges chat shows beside it — and nothing that identifies the
// account behind it. The badges go out as the same public state /api/badges gives (publicBadges.ts),
// so the overlay renders them through the chat's own badge order.
import type { BadgeSnapshot } from "./badgeCache.ts";
import type { BadgeUserState } from "./badgeSlots.ts";
import { publicBadgeStates } from "./publicBadges.ts";

export type CreditStyleRow = { key: string; matrix_id: string; username_color: string | null; username_style: unknown };
export type CreditStyle = { usernameColor: string | null; usernameStyle: unknown; badges: BadgeUserState | null };

export function creditStyles(
  rows: CreditStyleRow[],
  snap: Pick<BadgeSnapshot, "cat" | "slots" | "mods" | "subs" | "gifts">,
  staff: ReadonlySet<string>,
): Record<string, CreditStyle> {
  const badges = publicBadgeStates(snap, staff, rows.map((r) => r.matrix_id));
  const out: Record<string, CreditStyle> = {};
  for (const r of rows) {
    out[r.key] = { usernameColor: r.username_color ?? null, usernameStyle: r.username_style ?? null, badges: badges.get(r.matrix_id) ?? null };
  }
  return out;
}
