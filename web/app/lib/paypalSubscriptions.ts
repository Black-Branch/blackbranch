// PayPal Subscriptions API v1 — low-level only (subscription sources S3, spec §2.1, §5.2).
//
// The calls the PayPal subscription adapter (subscriptions/paypal.ts) makes, and the install's plan
// configuration. No route, no database here. Every call carries `AbortSignal.timeout(10_000)` and
// rides paypalClient.ts's token cache, the same as the tip calls.
//
// What is read from a PayPal body is exactly the fields named in the types below. A subscription's
// `subscriber` block can carry the payer's name, email and shipping address: only `payer_id` is
// read, and it is the record's account reference. Nothing here logs a body (payerName.scan.test.ts
// scans this file by its `paypal` prefix).
//
// Facts the PayPal docs did not confirm (spec §2.1), settled in the sandbox on 2026-10-21 by
// web/scripts/paypal-sandbox-facts.mjs (spec §1.8): a sale's `billing_agreement_id` IS the
// subscription's `I-…` id (F1); its fee is `transaction_fee.value` (F2); a sale refund names its
// sale in `sale_id` (F5); `GET /v1/payments/sale/{id}` answers a subscription's sale (F6).
import { paypalAccessToken, paypalApiBase, paypalConfigured } from "./paypalClient.ts";
import { instanceResolve } from "./instanceConfigServer.ts";
import { TIERS, type TierSlug } from "./tiers.ts";

/** The subscription fields this site reads (GET /v1/billing/subscriptions/{id}). */
export type PaypalSubscription = {
  id: string;
  status: string;
  plan_id?: string | null;
  custom_id?: string | null;
  create_time?: string | null;
  status_update_time?: string | null;
  subscriber?: { payer_id?: string | null } | null;
  billing_info?: {
    next_billing_time?: string | null;
    failed_payments_count?: number | null;
    last_payment?: { time?: string | null } | null;
  } | null;
};

/** The sale fields this site reads (a PAYMENT.SALE.* resource, or GET /v1/payments/sale/{id}). */
export type PaypalSale = {
  id: string;
  state?: string | null;
  amount?: { total?: string | null; currency?: string | null } | null;
  transaction_fee?: { value?: string | null; currency?: string | null } | null;
  billing_agreement_id?: string | null;
  create_time?: string | null;
};

/** A plan's monthly price, in the currency's minor units, as the subscribe sheet shows it. */
export type PaypalPlanPrice = { planId: string; amount: number; currency: string };

async function call(path: string, init: { method: string; body?: unknown }, f: typeof fetch): Promise<Response> {
  const token = await paypalAccessToken(f);
  return f(`${paypalApiBase()}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
}

function pickSubscription(j: Record<string, unknown>): PaypalSubscription {
  const bi = (j.billing_info ?? null) as PaypalSubscription["billing_info"];
  const sub = (j.subscriber ?? null) as { payer_id?: unknown } | null;
  return {
    id: String(j.id ?? ""),
    status: String(j.status ?? ""),
    plan_id: typeof j.plan_id === "string" ? j.plan_id : null,
    custom_id: typeof j.custom_id === "string" ? j.custom_id : null,
    create_time: typeof j.create_time === "string" ? j.create_time : null,
    status_update_time: typeof j.status_update_time === "string" ? j.status_update_time : null,
    subscriber: { payer_id: typeof sub?.payer_id === "string" ? sub.payer_id : null },
    billing_info: bi
      ? {
          next_billing_time: typeof bi.next_billing_time === "string" ? bi.next_billing_time : null,
          failed_payments_count: typeof bi.failed_payments_count === "number" ? bi.failed_payments_count : 0,
          last_payment: { time: typeof bi.last_payment?.time === "string" ? bi.last_payment.time : null },
        }
      : null,
  };
}

/** @parked consumed by the production binding of subscriptions/paypal.ts (PAYPAL_API there); the
 *  adapter's tests pass a fake api instead. Creates the subscription SERVER-side (spec §5.2, D13):
 *  `custom_id` is the server-minted intent id, so the browser never chooses it.
 *  `application_context.shipping_preference: "NO_SHIPPING"` (owner review E): a subscription ships
 *  nothing, and PayPal's default asks the buyer for an address — the tip orders carry the same
 *  preference (paypalClient.ts). It is the field the Subscriptions API documents for it. Returns the
 *  new `I-…` id. */
export async function createPaypalSubscription(args: { planId: string; customId: string }, f: typeof fetch = fetch): Promise<{ id: string; status: string }> {
  const res = await call("/v1/billing/subscriptions", { method: "POST", body: {
    plan_id: args.planId, custom_id: args.customId, application_context: { shipping_preference: "NO_SHIPPING" },
  } }, f);
  if (!res.ok) throw new Error(`paypal create subscription: ${res.status}`);
  const j = (await res.json()) as { id?: unknown; status?: unknown };
  if (typeof j.id !== "string" || !j.id) throw new Error("paypal create subscription: no id");
  return { id: j.id, status: typeof j.status === "string" ? j.status : "" };
}

/** @parked consumed by the production binding of subscriptions/paypal.ts. The subscription as
 *  PayPal holds it NOW, or null when PayPal has no such subscription (404). Any other non-2xx
 *  throws, so the webhook answers 500 and PayPal redelivers. */
export async function getPaypalSubscription(id: string, f: typeof fetch = fetch): Promise<PaypalSubscription | null> {
  const res = await call(`/v1/billing/subscriptions/${encodeURIComponent(id)}`, { method: "GET" }, f);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal get subscription: ${res.status}`);
  return pickSubscription((await res.json()) as Record<string, unknown>);
}

/** @parked consumed by the production binding of subscriptions/paypal.ts. PayPal's documented
 *  merchant cancel. Writes nothing here: the CANCELLED webhook does (D9). A subscription PayPal
 *  already ended answers 422; that is "already cancelled", not a failure. */
export async function cancelPaypalSubscription(id: string, f: typeof fetch = fetch): Promise<{ alreadyEnded: boolean }> {
  const res = await call(`/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: { reason: "Cancelled by the subscriber on the site" } }, f);
  if (res.status === 204 || res.ok) return { alreadyEnded: false };
  if (res.status === 422) return { alreadyEnded: true };
  throw new Error(`paypal cancel subscription: ${res.status}`);
}

/** @parked consumed by the production binding of subscriptions/paypal.ts. A sale, read when its
 *  refund arrives before it (§8.4): null on 404 (not a sale this account made). ⚠ F6. */
export async function getPaypalSale(id: string, f: typeof fetch = fetch): Promise<PaypalSale | null> {
  const res = await call(`/v1/payments/sale/${encodeURIComponent(id)}`, { method: "GET" }, f);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal get sale: ${res.status}`);
  return pickSale((await res.json()) as Record<string, unknown>);
}

/** The sale fields of a PAYMENT.SALE.* resource or a GET of one; nothing else is kept. */
export function pickSale(j: Record<string, unknown> | null | undefined): PaypalSale {
  const amount = (j?.amount ?? null) as { total?: unknown; currency?: unknown } | null;
  const fee = (j?.transaction_fee ?? null) as { value?: unknown; currency?: unknown } | null;
  return {
    id: typeof j?.id === "string" ? j.id : "",
    state: typeof j?.state === "string" ? j.state : null,
    amount: amount ? { total: typeof amount.total === "string" ? amount.total : null, currency: typeof amount.currency === "string" ? amount.currency : null } : null,
    transaction_fee: fee ? { value: typeof fee.value === "string" ? fee.value : null, currency: typeof fee.currency === "string" ? fee.currency : null } : null,
    billing_agreement_id: typeof j?.billing_agreement_id === "string" ? j.billing_agreement_id : null,
    create_time: typeof j?.create_time === "string" ? j.create_time : null,
  };
}

/** A plan's monthly price, or null when the plan is not one the site can sell: not ACTIVE, not
 *  one month per cycle, no fixed price. GET /v1/billing/plans/{id}. */
async function readPlanPrice(planId: string, f: typeof fetch): Promise<PaypalPlanPrice | null> {
  const res = await call(`/v1/billing/plans/${encodeURIComponent(planId)}`, { method: "GET" }, f);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`paypal get plan: ${res.status}`);
  const j = (await res.json()) as {
    status?: unknown;
    billing_cycles?: Array<{ tenure_type?: unknown; frequency?: { interval_unit?: unknown; interval_count?: unknown } | null;
      pricing_scheme?: { fixed_price?: { value?: unknown; currency_code?: unknown } | null } | null }> | null;
  };
  if (j.status !== "ACTIVE") return null;
  const regular = (j.billing_cycles ?? []).find((c) => c?.tenure_type === "REGULAR");
  if (!regular || regular.frequency?.interval_unit !== "MONTH" || Number(regular.frequency?.interval_count ?? 1) !== 1) return null;
  const value = Number(regular.pricing_scheme?.fixed_price?.value);
  const currency = regular.pricing_scheme?.fixed_price?.currency_code;
  if (!Number.isFinite(value) || value <= 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) return null;
  return { planId, amount: Math.round(value * 100), currency: currency.toLowerCase() };
}

const PRICE_OK_MS = 10 * 60_000;
const PRICE_FAIL_MS = 60_000;
/** A plan as the site can sell it: its price, or "inactive" (absent at PayPal, not ACTIVE, not one
 *  month per cycle, no fixed price). A read that FAILED is neither — it throws (security review of
 *  df38f985: one null for both made a payment's price floor fail open). */
export type PaypalPlanState = PaypalPlanPrice | "inactive";

const planCache = new Map<string, { at: number; ttl: number; value: PaypalPlanState } | { at: number; ttl: number; error: Error }>();

/** The plan's state, cached 10 minutes per plan id; a failed read is remembered for one minute and
 *  re-thrown meanwhile — the shape of supporterPrice.ts, so a PayPal outage costs one request a
 *  minute. Throws when PayPal could not be read. */
export async function paypalPlanState(planId: string, f: typeof fetch = fetch): Promise<PaypalPlanState> {
  const hit = planCache.get(planId);
  if (hit && Date.now() - hit.at < hit.ttl) {
    if ("error" in hit) throw hit.error;
    return hit.value;
  }
  try {
    const price = await readPlanPrice(planId, f);
    if (!price) console.warn("[paypal] plan %s is not an active monthly plan with a fixed price — PayPal subscriptions are not offered on it", planId);
    const value: PaypalPlanState = price ?? "inactive";
    planCache.set(planId, { at: Date.now(), ttl: PRICE_OK_MS, value });
    return value;
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.warn("[paypal] could not read plan %s: %s", planId, error.message);
    planCache.set(planId, { at: Date.now(), ttl: PRICE_FAIL_MS, error });
    throw error;
  }
}

/** @test-only clears the plan cache between tests (module state). */
export function _resetPaypalPlanCacheForTests(): void {
  planCache.clear();
}

// ── The webhook's cheap pre-check ─────────────────────────────────────────────────────────────

const TRANSMISSION_HEADERS = ["paypal-transmission-id", "paypal-transmission-time", "paypal-transmission-sig", "paypal-auth-algo", "paypal-cert-url"];

/** Could this request be a PayPal webhook delivery at all? Every transmission header present, and
 *  the certificate URL an https address on paypal.com or one of its subdomains. Not verification —
 *  verify-webhook-signature still decides — only what refuses an obvious forgery without a call to
 *  PayPal for it. */
export function plausiblePaypalDelivery(headers: Headers): boolean {
  if (TRANSMISSION_HEADERS.some((h) => !headers.get(h)?.trim())) return false;
  let cert: URL;
  try { cert = new URL(headers.get("paypal-cert-url")!); } catch { return false; }
  const host = cert.hostname.toLowerCase();
  return cert.protocol === "https:" && (host === "paypal.com" || host.endsWith(".paypal.com"));
}

// ── The install's plans (spec §11 `paypal.plans`: tier slug → PayPal plan id) ────────────────────

/** The setting that maps each tier to its PayPal plan. */
const PLANS_KEY = "paypal.plans";
const PLAN_ID = /^P-[A-Za-z0-9]{6,64}$/;

/** A `paypal.plans` value, checked: only known tier slugs, only plan-shaped ids. Accepts the
 *  object a `tierMap` setting resolves to, or the same object as JSON text. Anything else is an
 *  empty map, which offers and entitles nothing. Pure.
 *  @test-only exported so paypalRecords.test.ts can feed it every shape; paypalPlans (this file)
 *  is its caller. */
export function parsePaypalPlans(raw: unknown): Partial<Record<TierSlug, string>> {
  let v: unknown = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return {}; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Partial<Record<TierSlug, string>> = {};
  for (const [slug, plan] of Object.entries(v as Record<string, unknown>)) {
    if (!Object.hasOwn(TIERS, slug) || typeof plan !== "string" || !PLAN_ID.test(plan.trim())) continue;
    out[slug as TierSlug] = plan.trim();
  }
  return out;
}

/** The install's PayPal plans (`paypal.plans`, env PAYPAL_PLANS: JSON `{"supporter":"P-…"}`), read
 *  at call time like every setting. Unset → no plans, and PayPal subscriptions are not offered. */
export function paypalPlans(): Partial<Record<TierSlug, string>> {
  return parsePaypalPlans(instanceResolve(PLANS_KEY).value);
}

/** PayPal subscriptions can be sold: the PayPal module is on with its keys, and a plan is set for
 *  the one tier. (The plan's price is checked separately, at PayPal.) */
export function paypalSubscriptionsConfigured(): boolean {
  return paypalConfigured() && Boolean(paypalPlans().supporter);
}
