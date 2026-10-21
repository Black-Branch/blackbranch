// The Supporter subscription's price, read from Stripe. SERVER ONLY.
//
// The setting `stripe.supporterPriceId` names a Stripe Price (price_…). What it costs and in which
// currency live at Stripe, never in this code: the Support panel shows that amount, a gift charges
// it per month, and with no usable price the site does not offer subscriptions or gifts at all —
// hidden, never a 503 the viewer finds by pressing the button.
//
// "Usable" is what the Stripe setup page's live check demands too: active, recurring, monthly, one
// month per interval, with a fixed amount. Anything else reads as "no price" with one log line
// naming what is wrong (never the key).
//
// Cached 10 minutes per price id (a price is immutable at Stripe; only the id in the setting
// changes, and a changed id misses the cache at once). A failed read is remembered for one minute,
// so a Stripe outage costs one request a minute, not one per page view — and an outage hides the
// subscription for that minute rather than offering a checkout that cannot start.

import { instanceString } from "./instanceConfigServer.ts";
import { getStripe, stripeConfigured } from "./stripe.ts";

export type SupporterPrice = {
  /** The Stripe Price id the checkout charges. */
  id: string;
  /** Per month, in the currency's minor units (cents for usd, yen for jpy) — Stripe's unit_amount. */
  amount: number;
  /** Lower-case ISO code, as Stripe writes it ("usd"). */
  currency: string;
};

/** The fields of a Stripe Price this reads. */
export type PriceLike = {
  id: string;
  active?: boolean | null;
  type?: string | null;
  currency?: string | null;
  unit_amount?: number | null;
  recurring?: { interval?: string | null; interval_count?: number | null } | null;
};

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

/** Why a price cannot be the monthly subscription, or null when it can. */
function priceProblem(p: PriceLike): string | null {
  if (p.active !== true) return "is archived in Stripe (not active)";
  if (p.type !== "recurring" || !p.recurring) return "is a one-time price, not a recurring one";
  if (p.recurring.interval !== "month" || (p.recurring.interval_count ?? 1) !== 1) return "does not renew every month";
  if (typeof p.unit_amount !== "number" || !Number.isInteger(p.unit_amount) || p.unit_amount <= 0) return "has no fixed amount";
  if (typeof p.currency !== "string" || !/^[a-z]{3}$/i.test(p.currency)) return "has no currency";
  return null;
}

type Deps = {
  configured: () => boolean;
  priceId: () => string | null;
  retrieve: (id: string) => Promise<PriceLike>;
  now: () => number;
  log: Pick<Console, "warn">;
};

const realDeps: Deps = {
  configured: stripeConfigured,
  priceId: () => instanceString("stripe.supporterPriceId"),
  retrieve: (id) => getStripe().prices.retrieve(id) as Promise<PriceLike>,
  now: () => Date.now(),
  log: console,
};

/** @test-only the factory takes stub deps; production uses `supporterPrice` below. */
export function createSupporterPrice(deps: Deps = realDeps) {
  let cached: { id: string; at: number; ttl: number; value: SupporterPrice | null } | null = null;
  let inflight: { id: string; p: Promise<SupporterPrice | null> } | null = null;
  const warned = new Set<string>();
  const warnOnce = (key: string, line: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    deps.log.warn(line);
  };

  async function read(id: string): Promise<SupporterPrice | null> {
    try {
      const p = await deps.retrieve(id);
      const problem = priceProblem(p);
      if (problem) {
        warnOnce(`${id}:${problem}`, `[billing] the Supporter price ${id} ${problem} — subscriptions and gifts are not offered until it is fixed (Admin Panel → Stripe)`);
        cached = { id, at: deps.now(), ttl: OK_TTL_MS, value: null };
        return null;
      }
      const value = { id, amount: p.unit_amount as number, currency: (p.currency as string).toLowerCase() };
      cached = { id, at: deps.now(), ttl: OK_TTL_MS, value };
      return value;
    } catch (e) {
      // The SDK's message names the price id and Stripe's reason ("No such price"), never the key.
      const why = e instanceof Error ? e.message : String(e);
      warnOnce(`${id}:err:${why}`, `[billing] could not read the Supporter price ${id} from Stripe: ${why} — subscriptions and gifts are hidden until it answers`);
      cached = { id, at: deps.now(), ttl: FAIL_TTL_MS, value: null };
      return null;
    }
  }

  /** The usable Supporter price, or null: Stripe off, no price set, or a price that is not monthly. */
  return async function supporterPrice(): Promise<SupporterPrice | null> {
    if (!deps.configured()) return null;
    const id = deps.priceId()?.trim() || null;
    if (!id) return null;
    if (cached && cached.id === id && deps.now() - cached.at < cached.ttl) return cached.value;
    if (inflight && inflight.id === id) return inflight.p;
    const p = read(id).finally(() => { if (inflight?.p === p) inflight = null; });
    inflight = { id, p };
    return p;
  };
}

const G = globalThis as typeof globalThis & { __supporterPrice?: () => Promise<SupporterPrice | null> };
/** The usable Supporter price, or null (see the header). One cache per process. */
export function supporterPrice(): Promise<SupporterPrice | null> {
  return (G.__supporterPrice ??= createSupporterPrice())();
}
