// Cached snapshot of the badge tables behind GET /api/badges.
//
// THE PROBLEM. That endpoint is public, unauthenticated, and every connected
// client polls it. Each load is six full-table scans — site.badges,
// badge_slots, badge_unlocks, the mod list, active subscriptions and unexpired
// gifts — none of which are per-caller, to render a badge map that changes a
// few times a day.
//
// TWO failure modes are handled here:
//
//   1. Repetition — solved by a short TTL.
//   2. Stampede — when the TTL expires with N requests in flight, every one of
//      them misses and issues its own six queries. The busier the stream, the
//      worse the thundering herd, which is exactly backwards. So concurrent
//      misses share ONE in-flight load.
//
// FRESHNESS. A TTL alone is not enough: equipping a badge must show up
// immediately, not up to TTL_MS later. Every write path calls invalidate(), so
// the TTL is only a backstop for state that changes outside those paths
// (subscription expiry, a gift lapsing, is_mod flipped directly in the DB).
//
// NEVER CACHE A FAILURE. The queries degrade to empty rows on error so a DB
// blip renders no badges rather than 500ing. Caching that would turn a
// one-request blip into TTL_MS of site-wide missing badges, so a degraded load
// is returned to the caller but not stored.

import pool from "@/lib/db";
import { createTtlCache } from "./ttlCache";
import { ENTITLED_VIEWERS_SQL, subscriptionSources } from "./subscriptions/entitlement";

const TTL_MS = 15_000;

export type CatRow = {
  id: number; name: string; image_url: string; is_subscriber: boolean; is_mod: boolean;
  unlock_criteria: { type?: string; price?: number } | null;
};
export type SlotRow = { matrix_id: string; base_slots: number; equipped: (number | null)[] | null };
export type UnlockRow = { matrix_id: string; badge_id: number };
export type IdRow = { matrix_id: string };

export type BadgeSnapshot = {
  cat: CatRow[]; slots: SlotRow[]; unlocks: UnlockRow[];
  mods: IdRow[]; subs: IdRow[]; gifts: IdRow[];
};

async function load(): Promise<{ data: BadgeSnapshot; complete: boolean }> {
  let complete = true;
  const fail = <T>(): { rows: T[] } => { complete = false; return { rows: [] as T[] }; };

  const [cat, slots, unlocks, mods, subs, gifts] = await Promise.all([
    pool.query<CatRow>(
      `SELECT id, name, image_url, is_subscriber, is_mod, unlock_criteria FROM site.badges ORDER BY id`
    ).catch(() => fail<CatRow>()),
    pool.query<SlotRow>(
      `SELECT matrix_id, base_slots, equipped FROM site.badge_slots`
    ).catch(() => fail<SlotRow>()),
    pool.query<UnlockRow>(
      `SELECT matrix_id, badge_id FROM site.badge_unlocks`
    ).catch(() => fail<UnlockRow>()),
    pool.query<IdRow>(
      `SELECT matrix_id FROM site.users WHERE is_mod OR is_admin`
    ).catch(() => fail<IdRow>()),
    // Viewers an entitling subscription record covers — the one fragment (subscriptions/entitlement.ts).
    pool.query<IdRow>(ENTITLED_VIEWERS_SQL, [subscriptionSources()]).catch(() => fail<IdRow>()),
    pool.query<IdRow>(
      `SELECT recipient_matrix_id AS matrix_id FROM site.gift_subscriptions WHERE expires_at > now()`
    ).catch(() => fail<IdRow>()),
  ]);

  return {
    data: {
      cat: cat.rows, slots: slots.rows, unlocks: unlocks.rows,
      mods: mods.rows, subs: subs.rows, gifts: gifts.rows,
    },
    complete,
  };
}

const cache = createTtlCache<BadgeSnapshot>({
  ttlMs: TTL_MS,
  // `cacheable: false` on a partial read — returned to the caller, not remembered.
  load: async () => { const { data, complete } = await load(); return { data, cacheable: complete }; },
});

/** The badge tables, cached for TTL_MS. Concurrent misses share one load. */
export const getBadgeSnapshot = (): Promise<BadgeSnapshot> => cache.get();

/** Drop the cache. Call from every path that writes badge/slot/unlock state. */
export function invalidateBadgeSnapshot(): void {
  cache.invalidate();
}
