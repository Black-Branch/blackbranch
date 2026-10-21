// The setup pages' own live checks — the ones the settings schema has no `test` for. Pure: the
// caller hands in fetch. Read-only, like every provider check (one GET), and nothing a provider
// answers is shown back except the fixed facts read from it.

export type CheckAnswer = { ok: boolean; detail: string };

/** The supporter subscription's Stripe Price (stripe.supporterPriceId): it must exist under the
 *  saved key, be active, recurring and monthly (contracts.md §6). The words name what is wrong. */
export async function checkStripePrice(priceId: string | null, secretKey: string | null, fetchImpl: typeof fetch): Promise<CheckAnswer> {
  if (!priceId) return { ok: false, detail: "no price id saved yet — paste one, then Check" };
  if (!/^price_[A-Za-z0-9]{4,}$/.test(priceId)) return { ok: false, detail: "a price id starts price_ (not the product id, prod_)" };
  if (!secretKey) return { ok: false, detail: "save the Stripe secret key first: the price is looked up with it" };
  const mode = /^(sk|rk)_live_/.test(secretKey) ? "live" : "test";
  let res: Response;
  try {
    res = await fetchImpl(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
      headers: { authorization: `Bearer ${secretKey}` }, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    return { ok: false, detail: e instanceof Error && e.name === "TimeoutError" ? "Stripe did not answer within 8 s — try again" : "could not reach Stripe — try again" };
  }
  if (res.status === 404) return { ok: false, detail: `Stripe has no price with this id in ${mode} mode — a ${mode} key sees only ${mode} prices` };
  if (res.status === 401) return { ok: false, detail: "Stripe refused the secret key (HTTP 401)" };
  if (res.status === 403) return { ok: false, detail: "the key cannot read prices — give the restricted key Read on Prices" };
  if (!res.ok) return { ok: false, detail: `Stripe answered HTTP ${res.status}` };
  let p: { active?: unknown; type?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null; unit_amount?: unknown; currency?: unknown };
  try { p = (await res.json()) as typeof p; } catch { return { ok: false, detail: "Stripe's answer could not be read" }; }
  if (p.active !== true) return { ok: false, detail: "the price is archived — make it active in Stripe (or make a new one)" };
  if (p.type !== "recurring") return { ok: false, detail: "a one-time price — the supporter subscription needs a Recurring price" };
  const every = p.recurring?.interval, count = p.recurring?.interval_count ?? 1;
  if (every !== "month" || count !== 1) {
    return { ok: false, detail: `bills every ${count === 1 ? "" : `${String(count)} `}${typeof every === "string" ? every : "?"} — the supporter subscription is monthly: make a Monthly price` };
  }
  return { ok: true, detail: `found: ${priceWords(p.unit_amount, p.currency)} a month (${mode})` };
}

/** An amount in the currency's minor units, in words ("$5.00"); the bare figure when Intl does not know the currency. */
function priceWords(amount: unknown, currency: unknown): string {
  if (typeof amount !== "number" || typeof currency !== "string") return "a price";
  try {
    const f = new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() });
    const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
    return f.format(amount / 10 ** digits);
  } catch {
    return `${amount} ${currency.toUpperCase()} (smallest units)`;
  }
}
