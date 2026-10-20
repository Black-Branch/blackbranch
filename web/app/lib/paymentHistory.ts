// Payment history as one list: what was RECEIVED (every row of stream.support_events — the ledger
// the support bar and the income totals read, any platform) and what went WRONG
// (site.payment_events: failures, refunds, disputes), newest first.
// Pure — the route queries, this shapes; node --test reads it.
import { SPEND_SINKS } from "./coins.ts";
import { isNativePlatform } from "./nativePlatform.ts";

export type PaymentRow = {
  key: string; time: string; who: string; kind: string | null;
  amount: number | null; currency: string | null;
  /** "received", or a problem's stored outcome code. */
  outcome: string;
  /** "site" (this site's own checkout) or the platform it came from. */
  source: string;
  /** Spent in the site's points (a sticker, a cheer…), not a card payment. */
  points: boolean;
  reasonText: string | null; link: string | null;
};

export type SupportEventRow = { id: string | number; created_at: Date | string; username: string; event_type: string | null; amount_usd: string | number; platform: string };
export type ProblemRow = {
  id: string | number; occurred_at: Date | string; matrix_id: string | null; display_name: string | null;
  kind: string | null; amount_cents: number | null; currency: string | null; outcome: string; reason_text: string | null;
  payment_intent_id: string | null; subscription_id: string | null;
};

const POINT_KINDS: ReadonlySet<string> = new Set(SPEND_SINKS);

/** "site" for the site's own platform, else the platform.
 *  @test-only receivedRow uses it; the test pins the mapping. */
export function paymentSource(platform: string): string {
  return isNativePlatform(platform) ? "site" : platform;
}

export function receivedRow(r: SupportEventRow): PaymentRow {
  const source = paymentSource(r.platform);
  return {
    key: `r:${r.id}`, time: new Date(r.created_at).toISOString(), who: r.username, kind: r.event_type,
    amount: Math.round(Number(r.amount_usd) * 100), currency: "usd", outcome: "received", source,
    points: source === "site" && POINT_KINDS.has(r.event_type ?? ""),
    reasonText: null, link: null,
  };
}

export function problemRow(r: ProblemRow): PaymentRow {
  return {
    key: `p:${r.id}`, time: new Date(r.occurred_at).toISOString(),
    who: r.matrix_id ? (r.display_name ?? r.matrix_id) : "guest",
    kind: r.kind, amount: r.amount_cents, currency: r.currency, outcome: r.outcome, source: "site", points: false,
    reasonText: r.reason_text,
    link: r.payment_intent_id
      ? `https://dashboard.stripe.com/payments/${r.payment_intent_id}`
      : r.subscription_id ? `https://dashboard.stripe.com/subscriptions/${r.subscription_id}` : null,
  };
}

/** Both lists merged newest first, cut to `limit`; `nextBefore` is the time to ask for older rows
 *  from, or null when neither list had more. */
export function mergePayments(received: readonly PaymentRow[], problems: readonly PaymentRow[], limit: number, moreFrom: { received: boolean; problems: boolean }): { rows: PaymentRow[]; nextBefore: string | null } {
  const all = [...received, ...problems].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.key < b.key ? 1 : -1));
  const rows = all.slice(0, limit);
  const more = all.length > limit || moreFrom.received || moreFrom.problems;
  return { rows, nextBefore: more && rows.length ? rows[rows.length - 1]!.time : null };
}
