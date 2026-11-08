import pool from "../../lib/db.ts";
import { highestTier, type TierSlug } from "./tiers.ts";
import { isStaff } from "./staff.ts";
import { VIEWER_TIERS_SQL, subscriptionSources } from "./subscriptions/entitlement.ts";
import { createTierCache } from "./tierCache.ts";

// Server-side subscription entitlements. Keeps the chat hot path cheap with a
// short TTL cache — subscription changes (from the billing webhook) take effect
// within CACHE_TTL. A query error is never cached (tierCache.ts).

const CACHE_TTL = 60_000;

// The active tier from the database, or null if not subscribed / lapsed. A user is
// a Supporter via any entitling subscription record of a service that counts
// (subscriptions/entitlement.ts — the one fragment; the highest tier wins) OR an
// unexpired gift sub. A query error throws: it is not an answer.
async function lookupTier(matrixId: string): Promise<TierSlug | null> {
  const { rows } = await pool.query<{ sub_tiers: (string | null)[]; gift_active: boolean }>(
    `SELECT
       ARRAY(${VIEWER_TIERS_SQL}) AS sub_tiers,
       EXISTS (
         SELECT 1 FROM site.gift_subscriptions g
         WHERE g.recipient_matrix_id = $1 AND g.expires_at > now()
       ) AS gift_active`,
    [matrixId, subscriptionSources()]
  );
  const row = rows[0];
  let tier: TierSlug | null = highestTier(row?.sub_tiers ?? []);
  if (!tier && row?.gift_active) tier = "supporter";
  return tier;
}

// A blip keeps a Supporter a Supporter for one more TTL past the last good read; then null.
const tiers = createTierCache<TierSlug>({ ttlMs: CACHE_TTL, serveStaleForMs: 2 * CACHE_TTL, lookup: lookupTier });

// The active tier for a user, or null if not subscribed / lapsed.
export async function getActiveTier(matrixId: string): Promise<TierSlug | null> {
  // Staff/bot are comp Supporters by code — always entitled, no Stripe row needed.
  if (isStaff(matrixId)) return "supporter";
  return tiers.get(matrixId);
}

// Drop a cached entitlement (e.g. right after the webhook mutates a sub) so the
// next read reflects the change immediately rather than waiting out the TTL.
export function invalidateTier(matrixId: string): void {
  tiers.invalidate(matrixId);
}

// Chat send allowance per rate-limit window. Subscribers get a higher ceiling.
const CHAT_RATE_BASE = 5;
const CHAT_RATE_SUB = 12;
export function chatRateLimitFor(tier: TierSlug | null): number {
  return tier ? CHAT_RATE_SUB : CHAT_RATE_BASE;
}
