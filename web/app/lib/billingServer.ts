import type Stripe from "stripe";
import { siteName } from "@/app/lib/siteName";
import pool from "@/lib/db";
import { staffMatrixIds, isStaff } from "./staff";
import { invalidateBadgeSnapshot } from "./badgeCache";

// Server-only billing helpers shared by the checkout + donate routes. The
// viewer's Stripe customer (ensureStripeCustomer) lives in stripeCustomer.ts.

// Dark Checkout branding that matches the in-page modal. `buttonColor` lets each
// flow carry its own accent (amber for the subscription, emerald for donations).
// Checkout adapts text contrast automatically to the dark background.
export function supportBranding(buttonColor: string): Stripe.Checkout.SessionCreateParams.BrandingSettings {
  return {
    background_color: "#18181b", // zinc-900, matches the modal surface
    button_color: buttonColor,
    border_style: "rounded",
    font_family: "inter",
    display_name: siteName(),
  };
}

// Show a returning customer their previously saved cards. We deliberately omit
// `payment_method_save` (the opt-in checkbox): subscriptions must save the card
// regardless, and donations force-save via `setup_future_usage` — combining the
// checkbox with either is contradictory and Stripe can reject it. The filter just
// widens which saved methods are displayed (default is only `always`).
export const SAVED_PM_OPTIONS: Stripe.Checkout.SessionCreateParams.SavedPaymentMethodOptions = {
  allow_redisplay_filters: ["always", "limited", "unspecified"],
};

// Persist name + billing address back onto the customer so they prefill next time.
export const CUSTOMER_UPDATE: Stripe.Checkout.SessionCreateParams.CustomerUpdate = {
  name: "auto",
  address: "auto",
};

// ── Subscriber badge ─────────────────────────────────────────────────────────
// The Subscriber badge tracks entitlement (own subscription OR an active gift).
// An admin picks which badge represents Supporter via the is_subscriber flag
// (migrate-v54); we fall back to the legacy name='Subscriber' for safety. Cached
// per process; cleared by resetSubscriberBadgeCache when an admin re-points it.
// Shared by the billing webhook and the gift flow.
let subBadgeId: number | null = null;
let subBadgeResolved = false;
async function getSubscriberBadgeId(): Promise<number | null> {
  if (subBadgeResolved) return subBadgeId;
  // Prefer the flagged badge; fall back to the legacy named one. A flagged badge
  // always wins over the name match.
  const { rows } = await pool
    .query(
      `SELECT id FROM site.badges
       WHERE is_subscriber OR name = 'Subscriber'
       ORDER BY is_subscriber DESC, id
       LIMIT 1`
    )
    .catch(() => ({ rows: [] as { id: number }[] }));
  subBadgeId = rows[0]?.id != null ? Number(rows[0].id) : null;
  subBadgeResolved = true;
  return subBadgeId;
}

export function resetSubscriberBadgeCache(): void {
  subBadgeResolved = false;
  subBadgeId = null;
}

// Re-point the subscriber badge to `newBadgeId` (already flag-flipped by the caller):
// unlock the new badge for the current entitled set and swap it into slot 0 wherever
// the OLD subscriber badge was equipped — so every Supporter's icon updates at once.
export async function reassignSubscriberBadge(newBadgeId: number, oldBadgeId: number | null): Promise<void> {
  const staff = Array.from(staffMatrixIds());
  // Unlock the new badge for everyone currently entitled (own sub OR unexpired gift).
  await pool.query(
    `INSERT INTO site.badge_unlocks (matrix_id, badge_id)
     SELECT mid, $1 FROM (
       SELECT matrix_id AS mid FROM site.subscriptions
         WHERE status IN ('active','trialing','past_due') AND matrix_id IS NOT NULL
       UNION
       SELECT recipient_matrix_id FROM site.gift_subscriptions
         WHERE expires_at > now()
     ) entitled
     ON CONFLICT DO NOTHING`,
    [newBadgeId]
  );
  // Swap the equipped icon: anyone wearing the old sub badge in slot 0 now wears
  // the new one. (Staff are curated separately and keep their own equips.)
  if (oldBadgeId != null && oldBadgeId !== newBadgeId) {
    await pool.query(
      `UPDATE site.badge_slots SET equipped[1] = $1, updated_at = now()
       WHERE equipped[1] = $2 AND matrix_id <> ALL($3::text[])`,
      [newBadgeId, oldBadgeId, staff]
    );
  }
  invalidateBadgeSnapshot();   // catalog + unlocks + equips all moved
}

// Entitlement grants a SLOT (+1, derived live in the API) and auto-unlocks + equips
// the subscriber badge into slot 0 if that slot is empty. Named grantSubscriberBadge
// for call-site compatibility (gift flow). A lapse needs NO revoke: the slot count is
// derived from live entitlement, so the +1 (and thus the badge) simply disappears.
export async function grantSubscriberBadge(matrixId: string): Promise<void> {
  if (isStaff(matrixId)) return; // staff slots/badges are seeded by migration
  const badgeId = await getSubscriberBadgeId();
  if (badgeId == null) {
    console.error("[billing] Subscriber badge not found — run migrate-v49");
    return;
  }
  await pool.query(
    `INSERT INTO site.badge_unlocks (matrix_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [matrixId, badgeId]
  );
  await pool.query(
    `INSERT INTO site.badge_slots (matrix_id, equipped)
     VALUES ($1, ARRAY[$2]::bigint[])
     ON CONFLICT (matrix_id) DO UPDATE
       SET equipped = CASE
         WHEN site.badge_slots.equipped = '{}'::bigint[] OR site.badge_slots.equipped[1] IS NULL
         THEN ARRAY[$2]::bigint[]
         ELSE site.badge_slots.equipped
       END,
       updated_at = now()`,
    [matrixId, badgeId]
  );
  invalidateBadgeSnapshot();   // new unlock + equip must show immediately
}

// Keep the badge in lockstep with entitlement. Only entitle does work — the slot
// count derives from live subscription status, so a lapse self-heals (no revoke).
export async function syncSubscriberBadge(matrixId: string, entitled: boolean): Promise<void> {
  if (entitled) await grantSubscriberBadge(matrixId);
}
