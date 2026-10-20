import pool from "@/lib/db";
import { isActiveStatus, type TierSlug } from "./tiers";
import { isStaff } from "./staff";

// Server-side subscription entitlements. Keeps the chat hot path cheap with a
// short TTL cache — subscription changes (from the billing webhook) take effect
// within CACHE_TTL.

const tierCache = new Map<string, { tier: TierSlug | null; exp: number }>();
const CACHE_TTL = 60_000;

// The active tier for a user, or null if not subscribed / lapsed. A user is a
// Supporter via their own active Stripe subscription OR an unexpired gift sub.
export async function getActiveTier(matrixId: string): Promise<TierSlug | null> {
  // Staff/bot are comp Supporters by code — always entitled, no Stripe row needed.
  if (isStaff(matrixId)) return "supporter";

  const now = Date.now();
  const hit = tierCache.get(matrixId);
  if (hit && hit.exp > now) return hit.tier;

  const { rows } = await pool
    .query(
      `SELECT
         s.tier   AS sub_tier,
         s.status AS sub_status,
         EXISTS (
           SELECT 1 FROM site.gift_subscriptions g
           WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()
         ) AS gift_active
       FROM (SELECT $1::text AS mid) m
       LEFT JOIN site.subscriptions s ON s.matrix_id = m.mid`,
      [matrixId]
    )
    .catch(() => ({ rows: [] as { sub_tier: string | null; sub_status: string | null; gift_active: boolean }[] }));

  const row = rows[0];
  let tier: TierSlug | null = null;
  if (isActiveStatus(row?.sub_status)) tier = (row?.sub_tier as TierSlug | null) ?? null;
  else if (row?.gift_active) tier = "supporter";

  if (tierCache.size > 5000) tierCache.clear();
  tierCache.set(matrixId, { tier, exp: now + CACHE_TTL });
  return tier;
}

// Drop a cached entitlement (e.g. right after the webhook mutates a sub) so the
// next read reflects the change immediately rather than waiting out the TTL.
export function invalidateTier(matrixId: string): void {
  tierCache.delete(matrixId);
}

// Chat send allowance per rate-limit window. Subscribers get a higher ceiling.
const CHAT_RATE_BASE = 5;
const CHAT_RATE_SUB = 12;
export function chatRateLimitFor(tier: TierSlug | null): number {
  return tier ? CHAT_RATE_SUB : CHAT_RATE_BASE;
}
