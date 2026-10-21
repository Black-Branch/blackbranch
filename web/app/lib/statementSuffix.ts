// The per-kind suffix a payment-mode checkout adds to the card statement
// line, kept OFF when prefix + "* " + suffix would exceed Stripe's 22-char
// statement-descriptor ceiling. Measured in the sandbox (not assumed): Stripe
// never rejects a create over that combined length — it TRUNCATES THE PREFIX
// to fit ("SITENAME-PAYMENTS-D* TIP" from a 19-char descriptor) and rejects
// only a suffix that is itself over 22 — so TIP/GIFT/the points suffix can
// never fail a checkout. The guard exists for the policy "omit rather than
// truncate": a chopped business name on a bank statement is worse than no
// suffix. getStatementPrefixLength reads the live account setting once per
// process; a failed read resolves to 22 for that request (suffix omitted) and
// is not cached. No prefix configured (length 0, or fewer) also means no
// suffix.
import type Stripe from "stripe";
import { currencyName } from "./currency.ts";

/** A points purchase's suffix is the currency's own name: upper-cased, letters and digits only,
 *  at most 10 — "CREDITS" for an install that calls it Credits, "POINTS" by default. Stripe needs a
 *  letter in it; a name with none falls back to POINTS. */
function pointsSuffix(): string {
  const s = currencyName().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  return /[A-Z]/.test(s) ? s : "POINTS";
}

const SUFFIX_BY_KIND = {
  donation: () => "TIP",
  gift: () => "GIFT",
  coin_purchase: pointsSuffix,
} as const;

const MAX_DESCRIPTOR = 22;
const SEPARATOR_LENGTH = 2; // Stripe joins them as "<prefix>* <suffix>"

export function statementSuffixFor(
  kind: "donation" | "gift" | "coin_purchase",
  prefixLength: number
): string | undefined {
  if (prefixLength <= 0) return undefined;
  const suffix = SUFFIX_BY_KIND[kind]();
  return prefixLength + SEPARATOR_LENGTH + suffix.length <= MAX_DESCRIPTOR ? suffix : undefined;
}

let cached: Promise<number> | null = null;

/** stripe.accounts.retrieve() ONCE per process (a module-level promise
 *  cache, not per-request). Any failure — network, auth, a sandbox key with
 *  no linked account — resolves to 22, so the suffix is always omitted
 *  rather than risk a checkout-session-create Stripe would reject. */
export function getStatementPrefixLength(stripe: Stripe): Promise<number> {
  if (!cached) {
    cached = stripe.accounts
      .retrieve(null)
      .then((account) => {
        const settings = account.settings;
        const prefix =
          settings?.card_payments?.statement_descriptor_prefix ?? settings?.payments?.statement_descriptor ?? "";
        return prefix.length;
      })
      .catch(() => {
        cached = null; // let the next request try again; this one omits the suffix
        return MAX_DESCRIPTOR;
      });
  }
  return cached;
}
