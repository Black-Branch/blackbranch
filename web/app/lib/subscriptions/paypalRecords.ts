// PayPal → subscription record: the PayPal adapter's mapping (subscription sources S3, spec §3.3,
// §3.4, D9). Pure. The adapter (paypal.ts) reads the subscription from PayPal under the viewer's
// lock and hands it here; the transition function writes what comes back. Nothing here reads an
// event body's state.
import type { PaypalSale, PaypalSubscription } from "../paypalSubscriptions.ts";
import type { TierSlug } from "../tiers.ts";
import type { NormalStatus, Observation } from "./types.ts";

import { GRACE_DAYS } from "./grace.ts";

const DAY = 86_400_000;
const date = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
/** One calendar month later, the Postgres way (Jan 31 + 1 month = Feb 28). */
function plusMonth(d: Date): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + 1);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/** The end of the period the subscriber has paid for, as best PayPal says: its next billing time,
 *  else what the record last knew, else a month after the last payment. */
function paidThrough(sub: PaypalSubscription, lastKnown: Date | null): Date | null {
  const next = date(sub.billing_info?.next_billing_time);
  if (next) return next;
  if (lastKnown) return lastKnown;
  const last = date(sub.billing_info?.last_payment?.time);
  return last ? plusMonth(last) : null;
}

/**
 * One PayPal subscription as an observation (§3.3):
 * - APPROVAL_PENDING → pending, renews false: nothing can charge until the viewer approves it, so
 *   an abandoned popup never blocks a later subscribe or an account deletion;
 * - APPROVED → pending, renews true (approved; its first payment is on its way);
 * - ACTIVE with no completed payment → pending; ACTIVE with a failed payment → past_due, access to
 *   a month after the last completed payment plus grace; otherwise active, access to the next
 *   billing time (never earlier than now) plus grace;
 * - CANCELLED → active with renews false until the paid period ends (capped at a month after the
 *   last completed payment + grace), then ended; never paid → ended (D9);
 * - SUSPENDED → paused; EXPIRED (and anything unknown) → ended.
 * `lastKnownEnd` is the record's period_end, which a CANCELLED read may no longer carry.
 */
export function paypalObservation(
  sub: PaypalSubscription,
  a: { tier: TierSlug | null; observedAt: Date; now: Date; lastKnownEnd: Date | null; graceDays?: number },
): Observation {
  const grace = (a.graceDays ?? GRACE_DAYS) * DAY;
  const through = paidThrough(sub, a.lastKnownEnd);
  let status: NormalStatus;
  let renews = true;
  let accessUntil: Date | null = null;
  switch (sub.status) {
    case "APPROVAL_PENDING":
      status = "pending";
      renews = false;
      break;
    case "APPROVED":
      status = "pending";
      break;
    case "ACTIVE": {
      // Access is paid for, never merely promised (security review 2026-10-21, finding 1):
      // - no completed payment yet → pending (nothing entitles until money has moved);
      // - a failed payment → past_due, with access to a month after the LAST COMPLETED payment
      //   plus grace — a fixed end no re-check can move, however long PayPal keeps retrying;
      // - otherwise active, to the next billing time (never earlier than now) plus grace.
      const lastPaid = date(sub.billing_info?.last_payment?.time);
      if (!lastPaid) {
        status = "pending";
        break;
      }
      if ((sub.billing_info?.failed_payments_count ?? 0) > 0) {
        status = "past_due";
        accessUntil = new Date(plusMonth(lastPaid).getTime() + grace);
        break;
      }
      status = "active";
      const base = Math.max(through?.getTime() ?? a.now.getTime(), a.now.getTime());
      accessUntil = new Date(base + grace);
      break;
    }
    case "CANCELLED": {
      // What was PAID for, never what was merely scheduled (owner verification, 2026-10-21): no
      // completed payment → nothing was bought, ended; else the paid period's end, capped at a
      // calendar month after the last completed payment + grace — so a failed payment and then a
      // cancel cannot ride a far `next_billing_time` or a stale record end.
      renews = false;
      const lastPaid = date(sub.billing_info?.last_payment?.time);
      const cap = lastPaid ? plusMonth(lastPaid).getTime() + grace : null;
      const end = cap === null ? null : Math.min(through?.getTime() ?? cap, cap);
      if (end !== null && end > a.now.getTime()) {
        status = "active";
        accessUntil = new Date(end);
      } else {
        status = "ended";
      }
      break;
    }
    case "SUSPENDED":
      status = "paused";
      accessUntil = through ? new Date(through.getTime() + grace) : null;
      break;
    default: // EXPIRED, or a word PayPal adds later: never entitles
      status = "ended";
      renews = false;
  }
  return {
    provider: "paypal",
    externalId: sub.id,
    tier: a.tier,
    status,
    providerStatus: sub.status || "unknown",
    renews,
    periodEnd: through,
    accessUntil,
    accountRef: sub.subscriber?.payer_id ?? null,
    observedAt: a.observedAt,
  };
}

/** The tier a plan sells, from the install's map (tier → plan id); null for a plan it does not. */
export function tierForPlan(plans: Partial<Record<TierSlug, string>>, planId: string | null | undefined): TierSlug | null {
  if (!planId) return null;
  for (const [slug, plan] of Object.entries(plans)) if (plan === planId) return slug as TierSlug;
  return null;
}

/** PayPal's published US rate for PayPal Checkout (3.49% + $0.49, spec §2.1), used only when a sale
 *  reports no fee. Never below zero.
 *  @test-only exported so paypalRecords.test.ts can pin the rate; saleMoney (this file) is its caller. */
export function estimatePaypalNet(grossCents: number): number {
  return Math.max(0, grossCents - Math.round(grossCents * 0.0349 + 49));
}

/** What the site keeps of a sale: amounts in cents, the net from PayPal's own fee when it reports
 *  one in the same currency (⚠ F2: `transaction_fee.value`), else the published rate. */
export function saleMoney(sale: PaypalSale): { grossCents: number; netCents: number; currency: string; feeReported: boolean } | null {
  const gross = Number(sale.amount?.total);
  const currency = (sale.amount?.currency ?? "").toLowerCase();
  if (!Number.isFinite(gross) || gross <= 0 || !/^[a-z]{3}$/.test(currency)) return null;
  const grossCents = Math.round(gross * 100);
  const fee = Number(sale.transaction_fee?.value);
  const feeCurrency = (sale.transaction_fee?.currency ?? currency).toLowerCase();
  if (Number.isFinite(fee) && fee >= 0 && feeCurrency === currency && sale.transaction_fee?.value != null) {
    return { grossCents, netCents: Math.max(0, grossCents - Math.round(fee * 100)), currency, feeReported: true };
  }
  return { grossCents, netCents: estimatePaypalNet(grossCents), currency, feeReported: false };
}

/** The sale a PAYMENT.SALE.REFUNDED / REVERSED resource is about: `sale_id` (⚠ F5), else the
 *  `up` link to `/v1/payments/sale/<id>`, else — a REVERSED resource that is the sale itself — its
 *  own id when it names a billing agreement. */
export function saleIdOf(resource: unknown): string | null {
  const r = resource as { sale_id?: unknown; id?: unknown; billing_agreement_id?: unknown; links?: unknown } | null;
  if (typeof r?.sale_id === "string" && r.sale_id) return r.sale_id;
  if (Array.isArray(r?.links)) {
    for (const l of r.links as Array<{ rel?: unknown; href?: unknown } | null>) {
      if (l?.rel !== "up" && l?.rel !== "sale") continue;
      const m = typeof l.href === "string" ? /\/v1\/payments\/sale\/([^/?]+)\/?$/.exec(l.href) : null;
      if (m?.[1]) return m[1];
    }
  }
  if (typeof r?.billing_agreement_id === "string" && r.billing_agreement_id && typeof r.id === "string") return r.id;
  return null;
}
